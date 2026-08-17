namespace TeslaMock.Cli;

public sealed class Options
{
    public string Command = "run";
    public string Vin = "5YJ30123456789ABC";
    public bool Ble = true;
    public bool Tcp = true;
    public int TcpPort = 7070;
    public bool AutoTap;
    public int MotionMs = 2000;
    public bool PoweredLiftgate = true;
    public bool Broadcast;
    public string? StatePath;
    public bool Fresh;
    public int Mtu = 20;
    public bool Quiet;
    public Verbosity Verbosity = Verbosity.Normal;
    /// How often to say that the key has gone quiet, in seconds. 0 turns it off.
    public int SilenceEvery = 2;
    public bool SetRadioName;
    public bool RestoreRadioName;
    public bool Help;

    public static Options Parse(string[] args, out string? error)
    {
        var options = new Options();
        error = null;
        string? failure = null;
        var noState = false;
        var index = 0;

        if (args.Length > 0 && !args[0].StartsWith('-'))
        {
            options.Command = args[0];
            index = 1;
        }

        for (; index < args.Length; index++)
        {
            var arg = args[index];

            string? Value(string name)
            {
                if (index + 1 < args.Length && !args[index + 1].StartsWith("--")) return args[++index];
                failure = $"{name} needs a value";
                return null;
            }

            switch (arg)
            {
                case "--help":
                case "-h":
                    options.Help = true;
                    break;

                case "--vin":
                    options.Vin = Value(arg) ?? options.Vin;
                    break;

                case "--ble":
                    options.Ble = true;
                    break;

                case "--no-ble":
                    options.Ble = false;
                    break;

                case "--tcp":
                    options.Tcp = true;
                    if (index + 1 < args.Length && int.TryParse(args[index + 1], out var port))
                    {
                        options.TcpPort = port;
                        index++;
                    }
                    break;

                case "--no-tcp":
                    options.Tcp = false;
                    break;

                case "--auto-tap":
                    options.AutoTap = true;
                    break;

                case "--motion-ms":
                    if (int.TryParse(Value(arg), out var motion)) options.MotionMs = motion;
                    break;

                case "--no-liftgate":
                    options.PoweredLiftgate = false;
                    break;

                case "--broadcast":
                    options.Broadcast = true;
                    break;

                case "--state":
                    options.StatePath = Value(arg);
                    break;

                case "--no-state":
                    noState = true;
                    break;

                case "--fresh":
                    options.Fresh = true;
                    break;

                case "--mtu":
                    if (int.TryParse(Value(arg), out var mtu)) options.Mtu = mtu;
                    break;

                case "--quiet":
                    options.Quiet = true;
                    options.Verbosity = Verbosity.Quiet;
                    break;

                case "--verbose":
                case "-v":
                    options.Quiet = false;
                    options.Verbosity = Verbosity.Verbose;
                    break;

                case "--trace":
                    options.Quiet = false;
                    options.Verbosity = Verbosity.Trace;
                    break;

                case "--silence-every":
                    if (int.TryParse(Value(arg), out var silence)) options.SilenceEvery = silence;
                    break;

                case "--set":
                    options.SetRadioName = true;
                    break;

                case "--restore":
                    options.RestoreRadioName = true;
                    break;

                default:
                    error = $"unknown option {arg}";
                    return options;
            }

            if (failure is not null)
            {
                error = failure;
                return options;
            }
        }

        if (noState) options.StatePath = null;
        else options.StatePath ??= Vehicle.VehicleStore.DefaultPath(options.Vin);

        return options;
    }

    public const string Usage = """
        teslamock — a computer pretending to be a Tesla, so a key can be tested without one.

        USAGE
          teslamock [run]     [options]     be a car (Bluetooth and/or TCP)
          teslamock doctor    [options]     report whether this machine can be a BLE peripheral
          teslamock name      [options]     show, set or restore the radio name a scanner sees

        OPTIONS
          --vin <VIN>        the VIN to impersonate      (default 5YJ30123456789ABC)
          --no-ble           do not touch Bluetooth, TCP only
          --tcp [port]       listen on 127.0.0.1:port    (default 7070)
          --no-tcp           Bluetooth only
          --auto-tap         approve enrolment without waiting for a keycard tap
          --motion-ms <n>    how long a powered closure takes to travel (default 2000)
          --no-liftgate      a car with no powered boot: trunk-close is ignored
          --broadcast        push unsolicited VehicleStatus frames after every change
          --state <path>     where to keep the car's identity (default %LOCALAPPDATA%\teslamock)
          --no-state         keep nothing; a brand new car every launch
          --fresh            new keypair and empty whitelist, then save as usual
          --mtu <n>          notification payload size    (default 20)
          --quiet            only report commands, not protocol chatter
          -v, --verbose      every GATT operation, with sizes and timing deltas
          --trace            the above, with the bytes
          --silence-every <n>  say so every n seconds while the key is quiet (0 off)
          --set / --restore  for `name`: write or undo the radio name override

        WHEN THE WATCH RESTARTS
          A Zepp watch that trips its watchdog reboots without reporting anything, so
          the car is the only witness. Run with -v: every line carries how long it has
          been since the previous one, each outbound fragment is announced before it is
          written rather than after, and a timer says so while the key is silent. The
          last line before the gap is what the watch was in the middle of.

        THE NAME
          A Tesla is found by name, and Windows will not let a program choose the name
          its own advertisements carry — so this machine advertises under its own name
          whatever VIN it is pretending to have. Nothing here is broken by that: build
          the watch app with that name in freesla.config.js and it will look for this
          machine instead. `teslamock doctor` prints the exact line. The other way round
          is `teslamock name --set`, which gives this machine the car's name instead.

        KEYS, while running
          k  tap the keycard (approve a pending enrolment)     r  reboot: rotate the epoch
          d  leave the driver's door open / shut it            x  forget every enrolled key
          c  shut every closure                                n  reject the next counter
          s  print the car's state                             w  list enrolled keys
          b  broadcast a status frame                          q  quit
        """;
}
