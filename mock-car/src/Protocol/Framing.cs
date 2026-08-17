// Message framing for the GATT link.
//
// The characteristic is a byte stream, not a message queue: one notification
// carries at most (MTU - 3) bytes, so a message spans several and two short
// messages can share one. Every message is prefixed with its big-endian 16-bit
// length and the receiver reassembles.

namespace TeslaMock.Protocol;

public static class Framing
{
    public const int MaxMessageSize = 1024;

    public static List<byte[]> Frame(ReadOnlySpan<byte> message, int chunkSize)
    {
        if (message.Length > MaxMessageSize)
            throw new InvalidOperationException($"framing: message of {message.Length} bytes exceeds the protocol limit");

        var framed = new byte[message.Length + 2];
        framed[0] = (byte)(message.Length >> 8);
        framed[1] = (byte)message.Length;
        message.CopyTo(framed.AsSpan(2));

        var chunks = new List<byte[]>();
        if (chunkSize <= 0 || chunkSize >= framed.Length)
        {
            chunks.Add(framed);
            return chunks;
        }

        for (var offset = 0; offset < framed.Length; offset += chunkSize)
        {
            var take = Math.Min(chunkSize, framed.Length - offset);
            chunks.Add(framed.AsSpan(offset, take).ToArray());
        }
        return chunks;
    }
}

/// Accumulates inbound bytes and yields whole messages. An implausible length is
/// a hard error rather than a reason to wait for a gigantic message that will
/// never arrive.
public sealed class Reassembler
{
    private readonly List<byte> _buffer = new();

    public int Pending => _buffer.Count;

    public void Reset() => _buffer.Clear();

    public List<byte[]> Push(ReadOnlySpan<byte> chunk)
    {
        foreach (var b in chunk) _buffer.Add(b);

        var messages = new List<byte[]>();
        while (true)
        {
            if (_buffer.Count < 2) break;

            var expected = (_buffer[0] << 8) | _buffer[1];
            if (expected > Framing.MaxMessageSize)
            {
                _buffer.Clear();
                throw new FormatException($"framing: declared length {expected} is out of range");
            }
            if (_buffer.Count < expected + 2) break;

            messages.Add(_buffer.GetRange(2, expected).ToArray());
            _buffer.RemoveRange(0, expected + 2);
        }
        return messages;
    }
}
