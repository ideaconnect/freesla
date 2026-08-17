// The car on real Bluetooth: a GATT server carrying Tesla's vehicle service.
//
// Windows exposes the peripheral role only through WinRT, which is why this
// program is C#. The layout matches what a key expects to find, because the key
// declares it before connecting and gives up if it is not there:
//
//   service 00000211-…   write 00000212-…  (client -> vehicle)
//                        notify 00000213-…  (vehicle -> client, CCCD 0x2902)
//
// Windows adds the CCCD itself for a notify characteristic, so a client that
// enables notifications by writing 01 00 to it is served without us doing
// anything -- SubscribedClientsChanged is how that arrives here.
//
// The one thing Windows will not do is advertise an arbitrary local name: the
// name in the advertisement is the Bluetooth radio's name, which belongs to the
// machine rather than to the app. A Tesla is found by name, so the watch is
// built knowing which name to look for instead; TryPublishName below is the
// one lever an app has, and Program.ReportNameSituationAsync prints what a
// scanner will actually see either way.

using System.Threading.Channels;
using TeslaMock.Protocol;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

namespace TeslaMock.Transport;

public sealed class BleLink : ILink
{
    private readonly string _localName;
    private readonly int _preferredChunkSize;
    private readonly Channel<byte[]> _outbound = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions
    {
        SingleReader = true
    });

    private GattServiceProvider? _provider;
    private GattLocalCharacteristic? _writeCharacteristic;
    private GattLocalCharacteristic? _notifyCharacteristic;
    private BluetoothLEAdvertisementPublisher? _namePublisher;
    private Windows.Devices.Enumeration.DeviceWatcher? _connections;
    private Task? _pump;
    private CancellationTokenSource? _cancellation;
    private readonly Reassembler _reassembler = new();
    private readonly object _gate = new();

    public BleLink(string localName, int preferredChunkSize)
    {
        _localName = localName;
        _preferredChunkSize = preferredChunkSize;
    }

    public event Action<byte[]>? Message;
    public event Action<string>? Note;

    public bool IsConnected => _notifyCharacteristic?.SubscribedClients.Count > 0;

    public async Task StartAsync(CancellationToken token)
    {
        _cancellation = CancellationTokenSource.CreateLinkedTokenSource(token);

        var adapter = await BluetoothAdapter.GetDefaultAsync();
        if (adapter is null) throw new InvalidOperationException("no Bluetooth adapter — is Bluetooth switched on?");
        if (!adapter.IsPeripheralRoleSupported)
            throw new InvalidOperationException(
                "this Bluetooth adapter cannot act as a peripheral, so it cannot pretend to be a car. " +
                "A £10 BLE 5 USB dongle will.");

        var service = await GattServiceProvider.CreateAsync(Uuids.Service);
        if (service.Error != BluetoothError.Success)
            throw new InvalidOperationException($"could not create the GATT service: {service.Error}");
        _provider = service.ServiceProvider;

        var write = await _provider.Service.CreateCharacteristicAsync(Uuids.Write, new GattLocalCharacteristicParameters
        {
            CharacteristicProperties = GattCharacteristicProperties.Write | GattCharacteristicProperties.WriteWithoutResponse,
            WriteProtectionLevel = GattProtectionLevel.Plain
        });
        if (write.Error != BluetoothError.Success)
            throw new InvalidOperationException($"could not create the write characteristic: {write.Error}");
        _writeCharacteristic = write.Characteristic;
        _writeCharacteristic.WriteRequested += OnWriteRequested;

        var notify = await _provider.Service.CreateCharacteristicAsync(Uuids.Notify, new GattLocalCharacteristicParameters
        {
            CharacteristicProperties = GattCharacteristicProperties.Notify,
            ReadProtectionLevel = GattProtectionLevel.Plain
        });
        if (notify.Error != BluetoothError.Success)
            throw new InvalidOperationException($"could not create the notify characteristic: {notify.Error}");
        _notifyCharacteristic = notify.Characteristic;
        _notifyCharacteristic.SubscribedClientsChanged += OnSubscribedClientsChanged;

        // Windows holds a service registration for a while after the process
        // that made it goes away, and while it does, a second registration of
        // the same UUID advertises to Aborted rather than Started. A run that
        // was killed, or that failed on its way up, is therefore enough to make
        // the next one look like broken hardware. Hence the retry, and hence
        // the care taken below to hand the registration back on every exit path.
        if (!await TryAdvertiseAsync(token))
        {
            Note?.Invoke("the stack would not advertise; releasing the service and trying once more");
            StopAdvertising();
            await Task.Delay(1500, token);

            if (!await TryAdvertiseAsync(token))
            {
                var status = _provider.AdvertisementStatus;
                await DisposeAsync();
                throw new InvalidOperationException(
                    $"the stack would not advertise the vehicle service ({status}). " +
                    "Something still holds it — usually a previous run that did not exit cleanly. " +
                    "Wait a few seconds and try again, or switch Bluetooth off and on.");
            }
        }

        _provider.AdvertisementStatusChanged += (sender, _) =>
        {
            if (sender.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started)
                Note?.Invoke($"the advertisement stopped: {sender.AdvertisementStatus}");
        };

        TryPublishName(adapter);
        WatchConnections();

        _pump = Task.Run(() => PumpAsync(_cancellation.Token));
    }

    /// Starts advertising and waits for the stack to say so. The provider
    /// reports Aborted for a moment before it reports Started, so the first
    /// status change means nothing and only a poll settles it.
    private async Task<bool> TryAdvertiseAsync(CancellationToken token)
    {
        try
        {
            _provider!.StartAdvertising(new GattServiceProviderAdvertisingParameters
            {
                IsConnectable = true,
                IsDiscoverable = true
            });
        }
        catch (Exception e)
        {
            Note?.Invoke("StartAdvertising failed: " + e.Message);
            return false;
        }

        for (var attempt = 0; attempt < 30; attempt++)
        {
            if (_provider.AdvertisementStatus == GattServiceProviderAdvertisementStatus.Started) return true;
            await Task.Delay(100, token);
        }
        return false;
    }

    /// Hands the registration back. Called on every exit path, including the
    /// failed ones: a provider left advertising by a process that is going away
    /// is what makes the *next* run fail.
    private void StopAdvertising()
    {
        try
        {
            _provider?.StopAdvertising();
        }
        catch (Exception)
        {
        }
    }

    /// Best effort at getting the vehicle's name into the air.
    ///
    /// It is only an attempt. Windows refuses a Complete Local Name section in
    /// an app's advertisement, legacy or extended -- both come back as an
    /// unauthorized operation -- so the name a scanner sees is the radio's, and
    /// the watch is told to look for that one. This is kept because the refusal
    /// is a policy of this Windows build rather than a law of nature, and where
    /// it is allowed the mock should take it. Silence on failure is deliberate:
    /// the caller reports the name situation properly either way.
    private void TryPublishName(BluetoothAdapter adapter)
    {
        if (!adapter.IsExtendedAdvertisingSupported) return;

        try
        {
            var publisher = new BluetoothLEAdvertisementPublisher
            {
                UseExtendedAdvertisement = true,
                IsAnonymous = false
            };

            // 0x09 is the Complete Local Name data section.
            var writer = new DataWriter();
            writer.WriteBytes(System.Text.Encoding.UTF8.GetBytes(_localName));
            publisher.Advertisement.DataSections.Add(new BluetoothLEAdvertisementDataSection(0x09, writer.DetachBuffer()));

            // Reported from the callback rather than after Start() returns.
            // Start() is asynchronous, so a line printed straight after it
            // claims a name is in the air before the stack has said whether it
            // accepted one -- and when it then refuses, the run has printed two
            // contradictory statements about the same advertisement.
            publisher.StatusChanged += (sender, args) =>
            {
                if (args.Status == BluetoothLEAdvertisementPublisherStatus.Started)
                    Note?.Invoke($"also advertising the name {_localName} on a separate extended advertisement");
                else if (args.Status == BluetoothLEAdvertisementPublisherStatus.Aborted)
                    Note?.Invoke($"the name advertisement was refused by the stack ({args.Error})");
            };
            publisher.Start();
            _namePublisher = publisher;
        }
        catch (Exception)
        {
            // Expected on Windows. ReportNameSituationAsync says what a scanner
            // will see instead.
        }
    }

    /// Watches for any BLE device connecting to this machine.
    ///
    /// There is a blind spot without it, and it sits exactly where the fault
    /// being chased lives. A GattServiceProvider reports nothing when a central
    /// connects -- the first thing this program hears is the CCCD write, via
    /// SubscribedClientsChanged. So a key that connects and then dies while
    /// building its GATT profile, before it ever enables notifications, leaves
    /// a trace indistinguishable from a key that never found the car at all:
    /// both are silence. One of those is a name problem and the other is a
    /// crash, and they are fixed in different files.
    ///
    /// Windows will not say which device is talking to *this* service, so this
    /// sees every LE connection the machine has, including headphones. That is
    /// why it is verbose-only and why the lines it writes do not claim more
    /// than "something connected". Best effort throughout: a machine that
    /// refuses the watcher still gets everything else.
    private void WatchConnections()
    {
        if (!Trace.Enabled(Verbosity.Verbose)) return;

        try
        {
            var selector = BluetoothLEDevice.GetDeviceSelectorFromConnectionStatus(BluetoothConnectionStatus.Connected);
            var watcher = Windows.Devices.Enumeration.DeviceInformation.CreateWatcher(
                selector, null, Windows.Devices.Enumeration.DeviceInformationKind.AssociationEndpoint);

            // A DeviceWatcher opens by reporting everything that already
            // matches -- a keyboard and a mouse, on most desks -- and only then
            // starts reporting changes. Announcing those as arrivals would bury
            // the one arrival that matters under the furniture, so they are
            // gathered into a single line that names them as what they are:
            // the things the next connection will not be.
            var existing = new List<string>();
            var enumerated = false;

            watcher.Added += (_, device) =>
            {
                var described = Describe(device.Name, device.Id);
                if (!enumerated)
                {
                    lock (existing) existing.Add(described);
                    return;
                }
                Note?.Invoke($"an LE device connected to this machine: {described}" +
                             " — if that is the watch, it is now building its GATT profile");
            };

            watcher.EnumerationCompleted += (_, _) =>
            {
                enumerated = true;
                string[] already;
                lock (existing) already = existing.ToArray();
                Note?.Invoke(already.Length == 0
                    ? "nothing else is connected to this machine's Bluetooth"
                    : $"already connected, and therefore not the key: {string.Join(", ", already)}");
            };

            watcher.Removed += (_, update) =>
            {
                if (!enumerated) return;
                Note?.Invoke($"an LE device disconnected: {Describe(null, update.Id)}");
            };

            watcher.Start();
            _connections = watcher;
        }
        catch (Exception e)
        {
            Note?.Invoke("could not watch for LE connections, carrying on without: " + e.Message);
        }
    }

    private static string Describe(string? name, string id)
    {
        var shortId = id.Length > 24 ? "…" + id[^24..] : id;
        return string.IsNullOrWhiteSpace(name) ? shortId : $"{name} ({shortId})";
    }

    private void OnSubscribedClientsChanged(GattLocalCharacteristic sender, object args)
    {
        var clients = sender.SubscribedClients;
        if (clients.Count == 0)
        {
            int pending;
            lock (_gate)
            {
                pending = _reassembler.Pending;
                _reassembler.Reset();
            }

            // The epitaph. A watch that reboots takes its link down with it, so
            // this is the last thing the car learns about the fault -- and on
            // its own it says only "gone". What makes it useful is what it is
            // reported alongside: how long the key had been silent, and what it
            // was sent immediately before going quiet.
            Note?.Invoke(Trace.Epitaph("unsubscribed") +
                         (pending > 0 ? $"; {pending} bytes of a part-received message were dropped" : ""));
            return;
        }

        // The CCCD write is the key speaking, and it is the mark everything
        // after it is timed from.
        Trace.Heard();

        foreach (var client in clients)
            Note?.Invoke($"a key subscribed ({client.Session.DeviceId.Id}), " +
                         $"notifications up to {client.MaxNotificationSize} bytes" +
                         (Trace.Enabled(Verbosity.Verbose)
                             ? " — it should now send a handshake; anything else means it did not get that far"
                             : ""));
    }

    private async void OnWriteRequested(GattLocalCharacteristic sender, GattWriteRequestedEventArgs args)
    {
        // The deferral is what keeps the request alive across the await; without
        // it the stack tears the request down underneath us.
        using var deferral = args.GetDeferral();
        try
        {
            var request = await args.GetRequestAsync();

            var data = new byte[request.Value.Length];
            using (var reader = DataReader.FromBuffer(request.Value)) reader.ReadBytes(data);

            // Recorded here, at the first byte of the key's, rather than after
            // reassembly: a watch that dies part way through a message still
            // proves it was alive when it sent the fragment that arrived.
            Trace.Heard();

            List<byte[]> messages;
            int pending;
            lock (_gate)
            {
                try
                {
                    messages = _reassembler.Push(data);
                }
                catch (FormatException e)
                {
                    Note?.Invoke("framing error: " + e.Message);
                    _reassembler.Reset();
                    messages = new List<byte[]>();
                }
                pending = _reassembler.Pending;
            }

            if (Trace.Enabled(Verbosity.Verbose))
            {
                var kind = request.Option == GattWriteOption.WriteWithResponse ? "write" : "write-no-response";
                Note?.Invoke($"{kind} of {data.Length} bytes" +
                             (pending > 0 ? $", {pending} now buffered awaiting the rest" : "") +
                             (messages.Count > 0 ? $", completing {messages.Count} message(s)" : "") +
                             (Trace.Enabled(Verbosity.Trace) ? "  " + Trace.Hex(data) : ""));
            }

            if (request.Option == GattWriteOption.WriteWithResponse) request.Respond();

            foreach (var message in messages) Message?.Invoke(message);
        }
        catch (Exception e)
        {
            Note?.Invoke("write handling failed: " + e.Message);
        }
    }

    public void Send(byte[] message) => _outbound.Writer.TryWrite(message);

    /// One notification at a time, in order. A GATT server that fires them off
    /// in a loop is doing the same thing to its controller that a client doing
    /// unthrottled writes does to its own -- and on a small stack that is how
    /// the radio ends up wedged.
    private async Task PumpAsync(CancellationToken token)
    {
        try
        {
            await foreach (var message in _outbound.Reader.ReadAllAsync(token))
            {
                var characteristic = _notifyCharacteristic;
                if (characteristic is null) continue;

                var clients = characteristic.SubscribedClients;
                if (clients.Count == 0)
                {
                    Note?.Invoke("nothing is subscribed; reply dropped");
                    continue;
                }

                // --mtu 0 means "whatever the client says it can take"; anything
                // else is a ceiling on top of that, because a stack that reports
                // more than the peer actually accepts truncates silently.
                var chunkSize = _preferredChunkSize > 0 ? _preferredChunkSize : int.MaxValue;
                foreach (var client in clients) chunkSize = Math.Min(chunkSize, (int)client.MaxNotificationSize);
                if (chunkSize < 1) chunkSize = 20;

                var chunks = Framing.Frame(message, chunkSize);
                if (Trace.Enabled(Verbosity.Verbose))
                {
                    Note?.Invoke($"notifying {message.Length} bytes as {chunks.Count} fragment(s) of up to {chunkSize}");
                }

                var index = 0;
                foreach (var chunk in chunks)
                {
                    index++;

                    // Before the await, deliberately. The point of this line is
                    // the case where the next one never appears: a key that
                    // stops answering part way through a burst is identified by
                    // the fragment it was on, and a line written after the send
                    // can only ever name a fragment that already went.
                    if (Trace.Enabled(Verbosity.Verbose))
                    {
                        Note?.Invoke($"  fragment {index}/{chunks.Count}, {chunk.Length} bytes" +
                                     (Trace.Enabled(Verbosity.Trace) ? "  " + Trace.Hex(chunk) : ""));
                    }

                    var writer = new DataWriter();
                    writer.WriteBytes(chunk);
                    var results = await characteristic.NotifyValueAsync(writer.DetachBuffer());

                    foreach (var result in results)
                    {
                        if (result.Status != GattCommunicationStatus.Success)
                            Note?.Invoke($"fragment {index}/{chunks.Count} was not delivered: {result.Status}");
                    }
                }

                // Only now, and only at this level: a burst that completed is
                // one the key's controller accepted, which is a different fact
                // from the key having understood it.
                if (Trace.Enabled(Verbosity.Verbose))
                {
                    Note?.Invoke($"all {chunks.Count} fragment(s) accepted by the stack");
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception e)
        {
            Note?.Invoke("notification pump stopped: " + e.Message);
        }
    }

    // Safe to call twice: StartAsync tears itself down before it throws, and
    // the caller disposes what it was given regardless.
    public async ValueTask DisposeAsync()
    {
        try
        {
            _cancellation?.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        _outbound.Writer.TryComplete();

        try
        {
            _namePublisher?.Stop();
        }
        catch (Exception)
        {
        }
        _namePublisher = null;

        try
        {
            _connections?.Stop();
        }
        catch (Exception)
        {
        }
        _connections = null;

        // Unconditionally, not only when it reports Started: a provider that
        // aborted still holds the service, and holding it is precisely what
        // stops the next run from advertising.
        StopAdvertising();
        _provider = null;

        if (_pump is not null)
        {
            try
            {
                await _pump;
            }
            catch (Exception)
            {
            }
            _pump = null;
        }

        _cancellation?.Dispose();
        _cancellation = null;
    }
}
