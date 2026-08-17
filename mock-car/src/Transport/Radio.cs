// What this machine's Bluetooth can and cannot do, and what a scanner sees it
// called.
//
// A Tesla is found by name: a key scans for S<16 hex>C derived from the VIN and
// ignores everything else. Windows takes the name in an advertisement from the
// Bluetooth radio rather than from the program, and the radio's name lives in a
// registry key only SYSTEM may write, so a mock advertises as "DESKTOP-4F2A"
// however correct its GATT server is.
//
// That is a name to be reported, not a fault to be fixed: the watch is built
// with the name it should look for, so being called something is enough. This
// reports what that something is. It can also change it -- the heavier route,
// for when one watch build has to work with both a mock and a real car -- and
// does not pretend the change always takes.

using Microsoft.Win32;
using TeslaMock.Protocol;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

namespace TeslaMock.Transport;

public static class Radio
{
    private const string AdaptersKey = @"SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Adapters";

    public sealed record Report(
        bool HasAdapter,
        string Address,
        bool LowEnergySupported,
        bool PeripheralRoleSupported,
        bool CentralRoleSupported,
        bool ExtendedAdvertisingSupported,
        uint MaxAdvertisementDataLength,
        string RadioName,
        string RadioState)
    {
        /// The name a scanner will see. Windows takes it from the radio, which
        /// defaults to the computer's name; the registry value below overrides
        /// it when one has been written.
        public string AdvertisedName { get; init; } = Environment.MachineName;

        public bool AdvertisedNameIsOverride { get; init; }
    }

    public static async Task<Report> InspectAsync()
    {
        var adapter = await BluetoothAdapter.GetDefaultAsync();
        if (adapter is null)
            return new Report(false, "", false, false, false, false, 0, "", "no adapter");

        var address = string.Join(':', BitConverter.GetBytes(adapter.BluetoothAddress).Take(6).Reverse().Select(b => b.ToString("x2")));

        var name = "";
        var state = "unknown";
        try
        {
            var radio = await adapter.GetRadioAsync();
            if (radio is not null)
            {
                name = radio.Name;
                state = radio.State.ToString();
            }
        }
        catch (Exception)
        {
            // Radio access can be denied on locked-down machines; the rest of
            // the report is still worth having.
        }

        var over = ReadRegistryName(address);

        return new Report(
            true,
            address,
            adapter.IsLowEnergySupported,
            adapter.IsPeripheralRoleSupported,
            adapter.IsCentralRoleSupported,
            adapter.IsExtendedAdvertisingSupported,
            adapter.MaxAdvertisementDataLength,
            name,
            state)
        {
            AdvertisedName = over ?? Environment.MachineName,
            AdvertisedNameIsOverride = over is not null
        };
    }

    public static bool IsElevated()
    {
        try
        {
            using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            return new System.Security.Principal.WindowsPrincipal(identity)
                .IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// Brings a service up and advertises it for a moment. This is the question
    /// that matters -- not whether the API exists, but whether this machine will
    /// actually let a program be a peripheral.
    public static async Task<string> TryAdvertiseAsync(TimeSpan hold)
    {
        var service = await GattServiceProvider.CreateAsync(Uuids.Service);
        if (service.Error != BluetoothError.Success) return $"the GATT service could not be created: {service.Error}";

        var provider = service.ServiceProvider;
        var characteristic = await provider.Service.CreateCharacteristicAsync(Uuids.Notify, new GattLocalCharacteristicParameters
        {
            CharacteristicProperties = GattCharacteristicProperties.Notify,
            ReadProtectionLevel = GattProtectionLevel.Plain
        });
        if (characteristic.Error != BluetoothError.Success) return $"the characteristic could not be created: {characteristic.Error}";

        provider.StartAdvertising(new GattServiceProviderAdvertisingParameters { IsConnectable = true, IsDiscoverable = true });
        await Task.Delay(hold);
        var status = provider.AdvertisementStatus;
        if (status == GattServiceProviderAdvertisementStatus.Started) provider.StopAdvertising();
        return status.ToString();
    }

    /// Tries to put a chosen name in the air, legacy or extended, and reports
    /// what the stack made of it. Windows owns the name in its own
    /// advertisements, so this is the only lever an app has.
    public static async Task<string> TryPublishNameAsync(string name, bool extended, TimeSpan hold)
    {
        BluetoothLEAdvertisementPublisher publisher;
        try
        {
            publisher = new BluetoothLEAdvertisementPublisher { UseExtendedAdvertisement = extended };
            var writer = new DataWriter();
            writer.WriteBytes(System.Text.Encoding.UTF8.GetBytes(name));
            publisher.Advertisement.DataSections.Add(new BluetoothLEAdvertisementDataSection(0x09, writer.DetachBuffer()));
        }
        catch (Exception e)
        {
            return "rejected outright: " + e.Message;
        }

        var error = BluetoothError.Success;
        publisher.StatusChanged += (_, args) => error = args.Error;

        try
        {
            publisher.Start();
        }
        catch (Exception e)
        {
            return "Start() threw: " + e.Message;
        }

        await Task.Delay(hold);
        var status = publisher.Status;
        try
        {
            publisher.Stop();
        }
        catch (Exception)
        {
        }

        return error == BluetoothError.Success ? status.ToString() : $"{status} ({error})";
    }

    public static string RegistryPathFor(string address) =>
        $@"HKEY_LOCAL_MACHINE\{AdaptersKey}\{address.Replace(":", "")}";

    public static string? ReadRegistryName(string address)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey($@"{AdaptersKey}\{address.Replace(":", "")}");
            if (key?.GetValue("Name") is byte[] raw) return System.Text.Encoding.UTF8.GetString(raw).TrimEnd('\0');
        }
        catch (Exception)
        {
            // Reading is usually permitted; when it is not, the caller says so.
        }
        return null;
    }

    /// Returns null on success, or the reason it could not be done.
    ///
    /// The direct write is tried first and normally fails: the key is owned by
    /// SYSTEM, and an elevated prompt is still only an Administrator. The second
    /// attempt borrows SYSTEM's hands through a one-shot scheduled task, which
    /// is the only way to reach this key without installing anything.
    public static string? WriteRegistryName(string address, string name)
    {
        var key = $@"{AdaptersKey}\{address.Replace(":", "")}";

        try
        {
            using var direct = Registry.LocalMachine.OpenSubKey(key, writable: true);
            if (direct is not null)
            {
                direct.SetValue("Name", System.Text.Encoding.UTF8.GetBytes(name), RegistryValueKind.Binary);
                return null;
            }
        }
        catch (Exception)
        {
            // Expected. Fall through to the SYSTEM route.
        }

        if (!IsElevated())
            return "this needs to run as SYSTEM; start an Administrator prompt and try again";

        return WriteAsSystem(key, name);
    }

    private static string? WriteAsSystem(string key, string name)
    {
        var hex = Convert.ToHexString(System.Text.Encoding.UTF8.GetBytes(name));
        var command = $@"reg add ""HKLM\{key}"" /v Name /t REG_BINARY /d {hex} /f";
        const string taskName = "teslamock-radio-name";

        var create = Run("schtasks", $@"/create /tn {taskName} /tr ""cmd /c {command}"" /sc once /st 00:00 /ru SYSTEM /rl HIGHEST /f");
        if (create.code != 0) return "could not schedule the SYSTEM task: " + create.output.Trim();

        var run = Run("schtasks", $"/run /tn {taskName}");
        // The task is asynchronous, so give it a moment before tidying up.
        Thread.Sleep(2500);
        Run("schtasks", $"/delete /tn {taskName} /f");

        if (run.code != 0) return "the SYSTEM task would not start: " + run.output.Trim();
        return null;
    }

    private static (int code, string output) Run(string file, string arguments)
    {
        try
        {
            using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = file,
                Arguments = arguments,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            })!;
            var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
            process.WaitForExit(20000);
            return (process.ExitCode, output);
        }
        catch (Exception e)
        {
            return (-1, e.Message);
        }
    }

    /// Power-cycles the radio so the driver re-reads its name. Not guaranteed --
    /// some drivers only pick the name up when the device itself is restarted --
    /// so the caller reports what happened rather than promising a result.
    public static async Task<string> RestartRadioAsync()
    {
        try
        {
            var access = await Windows.Devices.Radios.Radio.RequestAccessAsync();
            if (access != Windows.Devices.Radios.RadioAccessStatus.Allowed)
                return "Windows did not allow this program to switch the radio: " + access;

            var radios = await Windows.Devices.Radios.Radio.GetRadiosAsync();
            foreach (var radio in radios)
            {
                if (radio.Kind != Windows.Devices.Radios.RadioKind.Bluetooth) continue;
                await radio.SetStateAsync(Windows.Devices.Radios.RadioState.Off);
                await Task.Delay(1500);
                await radio.SetStateAsync(Windows.Devices.Radios.RadioState.On);
                await Task.Delay(2500);
                return "the Bluetooth radio was switched off and on again";
            }
            return "no Bluetooth radio to restart";
        }
        catch (Exception e)
        {
            return "could not restart the radio: " + e.Message;
        }
    }
}
