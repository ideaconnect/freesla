// Persistence for the pretend car.
//
// The keypair is the part that matters. A key derives its session key from the
// vehicle's public key and caches it forever, because that derivation is the one
// expensive step in the protocol -- on a Zepp watch it is 87 seconds and has to
// be done on a phone. A mock that generated a fresh keypair every launch would
// force that round trip on every test run, so the car keeps its identity between
// runs exactly as a real one does.

using System.Text.Json;
using System.Text.Json.Serialization;

namespace TeslaMock.Vehicle;

public static class VehicleStore
{
    public sealed class KeyEntry
    {
        public string PublicKey { get; set; } = "";
        public ulong Role { get; set; }
        public ulong FormFactor { get; set; }
        public DateTime AddedUtc { get; set; }
    }

    public sealed class State
    {
        public string Vin { get; set; } = "";
        public string? PrivateKey { get; set; }
        public string? Epoch { get; set; }
        public uint Clock { get; set; }
        public int? LockState { get; set; }
        public List<KeyEntry> Keys { get; set; } = new();
        public Dictionary<string, uint> Counters { get; set; } = new();
    }

    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static string DefaultPath(string vin)
    {
        var directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "teslamock");
        return Path.Combine(directory, vin + ".json");
    }

    public static State? Load(string? path)
    {
        if (path is null || !File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<State>(File.ReadAllText(path), Options);
        }
        catch (Exception)
        {
            // A corrupt state file is not worth failing over: the car simply
            // starts as one that has never been paired.
            return null;
        }
    }

    public static void Save(string? path, State state)
    {
        if (path is null) return;
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        File.WriteAllText(path, JsonSerializer.Serialize(state, Options));
    }
}
