// teslamock: a computer pretending to be a Tesla.
//
// The Zepp simulator has no Bluetooth and a real car is not something to keep
// borrowing, so this is the third option: a program that answers to the vehicle
// protocol, over a real GATT server when the machine can manage one and over a
// socket when it cannot.

using TeslaMock.Cli;
using TeslaMock.Protocol;
using TeslaMock.Transport;
using TeslaMock.Vehicle;

namespace TeslaMock;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            // Box drawing and tick marks come out as mojibake in a redirected
            // console otherwise, which is exactly where the output gets read
            // from when a script is driving.
            Console.OutputEncoding = System.Text.Encoding.UTF8;
        }
        catch (Exception)
        {
        }

        var options = Options.Parse(args, out var error);
        if (error is not null)
        {
            Console.Error.WriteLine("teslamock: " + error);
            Console.Error.WriteLine("try --help");
            return 2;
        }
        if (options.Help)
        {
            Console.WriteLine(Options.Usage);
            return 0;
        }

        try
        {
            return options.Command switch
            {
                "run" => await RunAsync(options),
                "doctor" => await DoctorAsync(options),
                "name" => await NameAsync(options),
                _ => Unknown(options.Command)
            };
        }
        catch (Exception e)
        {
            Ui.Line("error", e.Message);
            return 1;
        }
    }

    private static int Unknown(string command)
    {
        Console.Error.WriteLine($"teslamock: unknown command '{command}'");
        Console.Error.WriteLine("try --help");
        return 2;
    }

    // --- being a car ---

    private static async Task<int> RunAsync(Options options)
    {
        if (!options.Ble && !options.Tcp)
        {
            Console.Error.WriteLine("teslamock: --no-ble and --no-tcp together leave the car with no way to be reached");
            return 2;
        }

        var restored = options.Fresh ? null : VehicleStore.Load(options.StatePath);
        var vehicle = new VirtualVehicle(options.Vin, restored)
        {
            MotionMs = options.MotionMs,
            PoweredLiftgate = options.PoweredLiftgate,
            AutoTap = options.AutoTap,
            BroadcastStatusChanges = options.Broadcast
        };

        Trace.Level = options.Verbosity;

        var quiet = options.Quiet;
        vehicle.Log = (category, text) =>
        {
            if (quiet && category is "rx" or "tx" or "session") return;
            Ui.Line(category, text);
        };

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cancellation.Cancel();
        };

        var links = new LinkSet(vehicle.Receive, text => Ui.Line("link", text));
        vehicle.Send = links.Send;

        Ui.Header(vehicle, options);

        if (options.Ble)
        {
            var ble = new BleLink(vehicle.LocalName, options.Mtu);
            try
            {
                await links.AddAsync(ble, cancellation.Token);
                Ui.Line("ble", $"GATT server up, advertising service {Uuids.Service}");
                await ReportNameSituationAsync(vehicle.LocalName);
            }
            catch (Exception e)
            {
                // Disposed rather than abandoned. A half-started peripheral that
                // is simply dropped keeps its service registered with the stack,
                // and the run after this one is then refused for a reason that
                // has nothing to do with it.
                await ble.DisposeAsync();

                Ui.Line("ble", "Bluetooth unavailable: " + e.Message);
                if (!options.Tcp)
                {
                    Ui.Line("ble", "nothing left to listen on; try --tcp");
                    return 1;
                }
                Ui.Line("ble", "carrying on over TCP only");
            }
        }

        if (options.Tcp)
        {
            var tcp = new TcpLink(options.TcpPort, options.Mtu);
            await links.AddAsync(tcp, cancellation.Token);
        }

        vehicle.StateChanged = () => Ui.Status(vehicle.Snapshot());
        Ui.Status(vehicle.Snapshot());
        Console.WriteLine();
        Ui.Line("ready", "waiting for a key.  press ? for the key list, q to quit");

        using var silence = StartSilenceReporter(links, options, cancellation.Token);

        await KeyLoopAsync(vehicle, cancellation);

        await links.DisposeAsync();
        if (options.StatePath is not null)
        {
            VehicleStore.Save(options.StatePath, vehicle.Persist());
            Ui.Line("state", "saved to " + options.StatePath);
        }
        return 0;
    }

    /// Says out loud that nothing is happening.
    ///
    /// This is the one thing an event-driven log cannot do, and the whole
    /// reason it matters here: a watch that trips its watchdog does not send an
    /// error, it stops. Every other line in this program is written because
    /// something arrived, so the failure being investigated is precisely the
    /// case in which the log goes blank and stays blank.
    ///
    /// Only fires while something is connected and only after the key has
    /// actually said something, so an idle car waiting for a watch does not
    /// narrate its own boredom.
    private static IDisposable StartSilenceReporter(LinkSet links, Options options, CancellationToken token)
    {
        var every = TimeSpan.FromSeconds(options.SilenceEvery);
        if (options.SilenceEvery <= 0 || !Trace.Enabled(Verbosity.Verbose))
        {
            return new Timer(_ => { }, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        }

        var reported = 0;
        return new Timer(_ =>
        {
            if (token.IsCancellationRequested) return;
            if (!links.AnyConnected)
            {
                reported = 0;
                return;
            }

            var (silentFor, lastSent, sentAgo) = Trace.Silence();
            if (silentFor < every)
            {
                reported = 0;
                return;
            }

            // Counted rather than repeated identically: an unchanging line is
            // easy to read past, and how many times it has repeated is the
            // measure of how long the key has been gone.
            reported++;
            // Two different faults, so two different sentences. A key that has
            // never been sent anything and has gone quiet died setting its own
            // link up -- before the protocol starts -- and saying "last sent X"
            // there would point at a reply that was never involved.
            Ui.Line("silent", Trace.NothingSentYet
                ? $"nothing from the key for {silentFor.TotalSeconds:F1}s (×{reported}). It subscribed " +
                  "and then went quiet without being sent anything. Whatever stopped it, " +
                  "it was doing it to itself"
                : $"nothing from the key for {silentFor.TotalSeconds:F1}s " +
                  $"(×{reported}). Last sent {sentAgo.TotalSeconds:F1}s ago: {lastSent}");
        }, null, every, every);
    }

    private static async Task KeyLoopAsync(VirtualVehicle vehicle, CancellationTokenSource cancellation)
    {
        // Redirected stdin means a script is driving, so the same single letters
        // arrive a line at a time instead of as keystrokes. Being scriptable is
        // what lets an automated run exercise the paths that need a human at the
        // car -- the keycard tap, and the reboot that rotates the epoch.
        if (Console.IsInputRedirected)
        {
            await ScriptLoopAsync(vehicle, cancellation);
            return;
        }

        while (!cancellation.IsCancellationRequested)
        {
            if (!Console.KeyAvailable)
            {
                try
                {
                    await Task.Delay(60, cancellation.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                continue;
            }

            if (Handle(vehicle, Console.ReadKey(intercept: true).KeyChar))
            {
                cancellation.Cancel();
                return;
            }
        }
    }

    private static async Task ScriptLoopAsync(VirtualVehicle vehicle, CancellationTokenSource cancellation)
    {
        var input = Console.OpenStandardInput();
        var reader = new StreamReader(input);

        while (!cancellation.IsCancellationRequested)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(cancellation.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            // End of input is not a reason to stop being a car: a script may
            // simply have nothing more to say while a key is still connected.
            if (line is null)
            {
                try
                {
                    await Task.Delay(Timeout.Infinite, cancellation.Token);
                }
                catch (OperationCanceledException)
                {
                }
                return;
            }

            line = line.Trim();
            if (line.Length == 0) continue;
            if (Handle(vehicle, line[0]))
            {
                cancellation.Cancel();
                return;
            }
        }
    }

    /// Returns true when the car has been asked to shut down.
    private static bool Handle(VirtualVehicle vehicle, char key)
    {
        switch (char.ToLowerInvariant(key))
        {
            case 'k':
                if (!vehicle.TapKeycard()) Ui.Line("enrol", "nothing is waiting to be approved");
                break;
            case 'd':
                vehicle.ToggleDoorAjar();
                break;
            case 'c':
                vehicle.ShutEverything();
                break;
            case 'r':
                vehicle.Reboot();
                break;
            case 'x':
                vehicle.ForgetKeys();
                break;
            case 'n':
                vehicle.FailNextCounter();
                break;
            case 'b':
                vehicle.BroadcastStatus();
                break;
            case 's':
                Ui.Status(vehicle.Snapshot());
                break;
            case 'w':
            {
                var enrolled = vehicle.DescribeKeys();
                if (enrolled.Count == 0) Ui.Line("keys", "no key is enrolled");
                foreach (var entry in enrolled) Ui.Line("keys", entry);
                break;
            }
            case '?':
            case 'h':
                Ui.Keys();
                break;
            case 'q':
                return true;
        }

        return false;
    }

    /// The name is the whole reason a key can find a particular car, so say
    /// plainly what is in the air.
    ///
    /// A name that is not the VIN's is no longer treated as a fault to be
    /// fixed here. Windows will not let a program name its own advertisements,
    /// and the registry key holding the radio's name belongs to SYSTEM, so the
    /// cheaper direction is the other one: the watch can be built to look for
    /// whatever this machine is called. That needs no elevation, nothing
    /// changed on the machine, and nothing put back afterwards.
    private static async Task ReportNameSituationAsync(string wanted)
    {
        var report = await Radio.InspectAsync();
        if (!report.HasAdapter) return;

        // Ordinal, not OrdinalIgnoreCase. A key compares the advertised name
        // exactly (lib/zepp/ble-session.js), so a radio called
        // "sade9a822faa374f8c" would not be found by a watch looking for
        // "Sade9a822faa374f8C" -- and a mock that called that a match would
        // send its owner off to debug a protocol that is working.
        if (string.Equals(report.AdvertisedName, wanted, StringComparison.Ordinal))
        {
            Ui.Line("ble", $"advertising as {report.AdvertisedName}, so a key scanning for this VIN will find it");
            return;
        }

        Ui.Line("ble", $"advertising as \"{report.AdvertisedName}\"; this VIN derives \"{wanted}\"");
        // "make the last line read", not "add this line": the constant is
        // already declared in that file, and a second declaration of it is a
        // syntax error rather than an override.
        Ui.Line("ble", $"to be found, make the last line of {WatchConfig.File} read:");
        Ui.Line("ble", "    " + WatchConfig.Line(report.AdvertisedName));
        Ui.Line("ble", "or give this machine the car's name instead with `teslamock name --set`");
    }

    // --- diagnostics ---

    private static async Task<int> DoctorAsync(Options options)
    {
        var wanted = Messages.VehicleLocalName(options.Vin);
        var report = await Radio.InspectAsync();

        Console.WriteLine();
        Ui.Field("VIN", options.Vin);
        Ui.Field("name from VIN", wanted);
        Console.WriteLine();

        if (!report.HasAdapter)
        {
            Ui.Verdict(false, "no Bluetooth adapter. Switch Bluetooth on, or run with --no-ble --tcp");
            return 1;
        }

        Ui.Field("adapter", report.Address);
        // The hardware's own name ("Intel(R) Wireless Bluetooth(R)"), which is
        // not the name it advertises under and is labelled so it cannot be read
        // as one. An Off radio advertises nothing at all, which is why the
        // state travels with it.
        Ui.Field("radio hardware", $"{report.RadioName} ({report.RadioState})");
        Ui.Field("advertises as", report.AdvertisedName + (report.AdvertisedNameIsOverride ? " (registry override)" : " (this machine's name)"));
        Console.WriteLine();
        Ui.Verdict(report.LowEnergySupported, "Bluetooth Low Energy");
        Ui.Verdict(report.PeripheralRoleSupported, "peripheral role: the one that decides whether a computer can be a car");
        Ui.Verdict(report.CentralRoleSupported, "central role");
        Ui.Verdict(report.ExtendedAdvertisingSupported, $"extended advertising (payload up to {report.MaxAdvertisementDataLength} bytes)");

        if (report.PeripheralRoleSupported)
        {
            Console.WriteLine();
            Ui.Field("advertising test", "starting the vehicle service…");
            var status = await Radio.TryAdvertiseAsync(TimeSpan.FromSeconds(2));
            Ui.Verdict(status == "Started", $"advertising the Tesla service: {status}");

            var legacy = await Radio.TryPublishNameAsync(wanted, extended: false, TimeSpan.FromSeconds(1));
            Ui.Verdict(legacy == "Started", $"name in a legacy advertisement: {legacy}");

            if (report.ExtendedAdvertisingSupported)
            {
                var extended = await Radio.TryPublishNameAsync(wanted, extended: true, TimeSpan.FromSeconds(1));
                Ui.Verdict(extended == "Started", $"name in an extended advertisement: {extended}");
            }
        }

        Console.WriteLine();
        var nameMatches = string.Equals(report.AdvertisedName, wanted, StringComparison.OrdinalIgnoreCase);
        if (nameMatches)
        {
            Ui.Verdict(true, "this machine already advertises the vehicle's name");
        }
        else
        {
            // Deliberately not a ✗. The two names differing is the normal state
            // of a Windows machine and does not stop anything: it is the watch
            // that decides which name to look for, and it can be told this one.
            Ui.Field("a scanner sees", report.AdvertisedName);
            Ui.Field("this VIN derives", wanted);
            Console.WriteLine();
            Console.WriteLine($"""
                  Those differ, and on Windows they usually will. A program cannot choose the
                  name in its own advertisements -- legacy and extended alike are refused -- so
                  the name comes from the Bluetooth radio, and the radio's name lives in a
                  registry key owned by SYSTEM.

                  The cheap way round it is to point the watch at this machine. Make the last
                  line of {WatchConfig.File} read this, and build the app:

                      {WatchConfig.Line(report.AdvertisedName)}

                  Empty that setting again before building for a real car: a build carrying it
                  looks for this name and nothing else.

                  The VIN still has to match. The override only decides which advertisement to
                  connect to; the VIN is signed into every command, so a watch paired to a
                  different one connects and then has everything it sends rejected -- which
                  reads as a protocol fault rather than as a setting.

                  The other direction still works and needs no rebuild -- `teslamock name --set`
                  from an Administrator prompt gives this machine the car's name until you
                  `--restore` it. And everything except the scan-by-name step can be tested over
                  --tcp with no Bluetooth at all.
                """);
        }
        Console.WriteLine();
        return report.PeripheralRoleSupported ? 0 : 1;
    }

    private static async Task<int> NameAsync(Options options)
    {
        var wanted = Messages.VehicleLocalName(options.Vin);
        var report = await Radio.InspectAsync();
        if (!report.HasAdapter)
        {
            Ui.Line("error", "no Bluetooth adapter");
            return 1;
        }

        Console.WriteLine();
        Ui.Field("adapter", report.Address);
        Ui.Field("advertises as", report.AdvertisedName);
        Ui.Field("needed for this VIN", wanted);
        Ui.Field("registry key", Radio.RegistryPathFor(report.Address));
        Ui.Field("running as", Radio.IsElevated() ? "Administrator" : "a normal user");
        Console.WriteLine();

        if (!options.SetRadioName && !options.RestoreRadioName)
        {
            Console.WriteLine($"""
                  Pass --set to advertise the vehicle's name, or --restore to put this machine's
                  own name back.

                  Before you do: this is the heavier of the two ways round the name, and it is
                  worth knowing the other one. The watch can be built to look for this machine
                  instead, which changes nothing on the machine at all. Make the last line of
                  {WatchConfig.File} read this, and build the app:

                      {WatchConfig.Line(report.AdvertisedName)}

                  Why --set is not simply a flag on the mock: Windows refuses to let a program put
                  a name in its own advertisements. The name a scanner sees belongs to the
                  Bluetooth radio, and the radio's name lives in a registry key owned by SYSTEM.
                  an Administrator prompt is not enough on its own. --set therefore runs the write
                  through a one-shot scheduled task as SYSTEM, so it needs an elevated prompt, and
                  then power-cycles the radio so the driver picks the new name up.

                  This changes the name your machine advertises to everything, not just to a
                  watch. --restore puts it back.
                """);
            Console.WriteLine();
            return 0;
        }

        var target = options.RestoreRadioName ? Environment.MachineName : wanted;
        var failure = Radio.WriteRegistryName(report.Address, target);
        if (failure is not null)
        {
            Ui.Verdict(false, $"could not set the name: {failure}");
            Console.WriteLine();
            return 1;
        }

        Ui.Field("restarting radio", await Radio.RestartRadioAsync());

        // Read back, because the write is not as direct as it looks: when the
        // key belongs to SYSTEM it goes out through a scheduled task, and all
        // WriteRegistryName can report is that the task started. Whether the
        // `reg add` inside it worked is only knowable from the key itself.
        //
        // And this is where the claim stops. The registry holding the new name
        // does not mean the driver has read it -- Windows cannot scan its own
        // advertisements, so nothing here can see what is actually in the air.
        var after = await Radio.InspectAsync();
        var written = string.Equals(after.AdvertisedName, target, StringComparison.Ordinal);
        Ui.Verdict(written, written
            ? $"the radio's name is now \"{target}\" in the registry"
            : $"the registry still says \"{after.AdvertisedName}\", so the write did not take");
        if (!written)
        {
            Console.WriteLine();
            return 1;
        }
        Console.WriteLine();
        Console.WriteLine("""
              Whether the driver has picked it up is not visible from this machine -- Windows
              cannot scan its own advertisements. Check from a phone with nRF Connect. If the
              old name is still in the air, disable and re-enable the Bluetooth adapter in
              Device Manager, or reboot.
            """);
        Console.WriteLine();
        return 0;
    }
}

/// Several transports, one car. Replies go back the way the request came, which
/// is what lets Bluetooth and a socket be served at the same time without the
/// vehicle knowing there is more than one.
public sealed class LinkSet : IAsyncDisposable
{
    private readonly List<ILink> _links = new();
    private readonly Action<byte[]> _onMessage;
    private readonly Action<string> _note;
    private ILink? _lastActive;

    public LinkSet(Action<byte[]> onMessage, Action<string> note)
    {
        _onMessage = onMessage;
        _note = note;
    }

    /// True while any transport has something subscribed or connected.
    public bool AnyConnected
    {
        get
        {
            foreach (var link in _links)
            {
                if (link.IsConnected) return true;
            }
            return false;
        }
    }

    public async Task AddAsync(ILink link, CancellationToken token)
    {
        link.Note += _note;
        link.Message += message =>
        {
            _lastActive = link;
            // A socket has no GATT write to record this at, so it is recorded
            // here as well; Trace.Heard is idempotent within a message.
            Trace.Heard();
            _onMessage(message);
        };
        await link.StartAsync(token);
        _links.Add(link);
    }

    public void Send(byte[] message)
    {
        var active = _lastActive;
        if (active is not null && active.IsConnected)
        {
            active.Send(message);
            return;
        }

        var delivered = false;
        foreach (var link in _links)
        {
            if (!link.IsConnected) continue;
            link.Send(message);
            delivered = true;
        }
        if (!delivered) active?.Send(message);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var link in _links) await link.DisposeAsync();
    }
}

/// The watch's build-time way out of the name problem.
///
/// Kept here as one place rather than spelled out at each of the three points
/// that print it, because it is a line somebody pastes into another program's
/// source: if it is wrong it is wrong silently, and the symptom appears on a
/// watch rather than in this output.
internal static class WatchConfig
{
    public const string File = "freesla.config.js";
    private const string Constant = "BLE_NAME_OVERRIDE";

    public static string Line(string name) =>
        $"export const {Constant} = '{Escape(name)}'";

    /// A Windows machine name cannot contain a quote or a backslash, so this
    /// never fires in practice. It is here because the alternative to escaping
    /// is emitting JavaScript that does not parse.
    private static string Escape(string name) =>
        name.Replace("\\", "\\\\").Replace("'", "\\'");
}

internal static class Ui
{
    private static readonly object Gate = new();

    public static void Header(VirtualVehicle vehicle, Options options)
    {
        Console.WriteLine();
        Write(ConsoleColor.White, "  teslamock: pretending to be a Tesla\n");
        Console.WriteLine("  ──────────────────────────────────────────────────────────────");
        Field("VIN", vehicle.Vin);
        // Labelled by where it comes from, not as "the" name: what a scanner
        // actually sees is the radio's name, which the ble lines report.
        Field("name from VIN", vehicle.LocalName);
        Field("service", Uuids.Service.ToString());
        Field("vehicle key", Convert.ToHexString(vehicle.PublicKey)[..24].ToLowerInvariant() + "…");
        Field("state file", options.StatePath ?? "(not saved)");
        Console.WriteLine();
    }

    public static void Field(string name, string value)
    {
        lock (Gate)
        {
            Console.Write("  " + name.PadRight(22));
            Write(ConsoleColor.Cyan, value + "\n");
        }
    }

    public static void Verdict(bool ok, string text)
    {
        lock (Gate)
        {
            Console.Write("  ");
            Write(ok ? ConsoleColor.Green : ConsoleColor.Red, ok ? "✓ " : "✗ ");
            Console.WriteLine(text);
        }
    }

    public static void Line(string category, string text)
    {
        lock (Gate)
        {
            Console.Write(DateTime.Now.ToString("HH:mm:ss") + "  ");
            // The elapsed/delta pair only under -v. At normal verbosity the
            // lines are milestones minutes apart and the arithmetic would be
            // noise; under -v they are a trace, and the gap between two of them
            // is the entire finding.
            if (Trace.Enabled(Verbosity.Verbose))
            {
                Write(ConsoleColor.DarkGray, Trace.Stamp() + "  ");
            }
            Write(Colour(category), category.PadRight(8));
            Console.WriteLine(text);
        }
    }

    /// A line that only exists above a verbosity level.
    public static void Detail(Verbosity level, string category, string text)
    {
        if (!Trace.Enabled(level)) return;
        Line(category, text);
    }

    public static void Status(VehicleSnapshot car)
    {
        var closures = new List<string>();
        foreach (var pair in car.Closures.OrderBy(p => p.Key))
        {
            if (pair.Value == ClosureState.Closed) continue;
            closures.Add($"{ClosureField.Name(pair.Key)} {ClosureState.Name(pair.Value)}");
        }

        lock (Gate)
        {
            Console.Write(DateTime.Now.ToString("HH:mm:ss") + "  ");
            Write(ConsoleColor.White, "car     ");
            Write(car.LockState == LockState.Locked ? ConsoleColor.Green : ConsoleColor.Yellow,
                LockState.Name(car.LockState));
            Console.Write(closures.Count == 0 ? " · everything shut" : " · " + string.Join(" · ", closures));
            Console.Write($" · {car.EnrolledKeys} key{(car.EnrolledKeys == 1 ? "" : "s")}");
            if (car.EnrolmentPending) Write(ConsoleColor.Magenta, " · enrolment waiting [k]");
            Console.WriteLine($" · epoch {car.EpochHex} · counter {car.Counter}");
        }
    }

    public static void Keys()
    {
        Console.WriteLine();
        Console.WriteLine("""
              k  approve a pending enrolment (the keycard tap)
              d  leave the driver's door open, or shut it
              c  shut every closure
              r  reboot the car: rotate the epoch, void every session
              x  forget every enrolled key
              n  reject the next command as a repeated counter
              b  broadcast an unsolicited status frame
              s  print the car's state          w  list enrolled keys
              q  quit
            """);
        Console.WriteLine();
    }

    private static ConsoleColor Colour(string category) => category switch
    {
        "cmd" => ConsoleColor.Green,
        "enrol" => ConsoleColor.Magenta,
        "reject" => ConsoleColor.Red,
        "error" => ConsoleColor.Red,
        "ble" => ConsoleColor.Blue,
        "link" => ConsoleColor.Blue,
        "ready" => ConsoleColor.White,
        "keys" => ConsoleColor.Cyan,
        // The colour of something being wrong without anything happening.
        "silent" => ConsoleColor.Yellow,
        "tx" => ConsoleColor.DarkCyan,
        _ => ConsoleColor.DarkGray
    };

    private static void Write(ConsoleColor colour, string text)
    {
        var previous = Console.ForegroundColor;
        Console.ForegroundColor = colour;
        Console.Write(text);
        Console.ForegroundColor = previous;
    }
}
