// Signature metadata: the authenticated context binding a command to one
// vehicle, one session and one moment in time.
//
// A flat TLV run -- tag byte, length byte, value -- in ascending tag order,
// closed with 0xFF. Written independently of the watch's encoder on purpose: a
// shared encoder with the TLV layout wrong would agree with itself and pass.

using System.Security.Cryptography;
using System.Text;

namespace TeslaMock.Protocol;

public sealed class Meta
{
    private readonly List<byte> _bytes = new();
    private int _lastTag = -1;

    public Meta Field(int tag, ReadOnlySpan<byte> value)
    {
        if (tag < _lastTag) throw new InvalidOperationException($"metadata: tag {tag} out of order");
        if (value.Length > 255) throw new InvalidOperationException($"metadata: field {tag} too long");
        _lastTag = tag;
        _bytes.Add((byte)tag);
        _bytes.Add((byte)value.Length);
        foreach (var b in value) _bytes.Add(b);
        return this;
    }

    public Meta Byte(int tag, byte value) => Field(tag, stackalloc byte[] { value });

    // Big-endian here, unlike the little-endian fixed32 the same value takes on
    // the protobuf wire.
    public Meta Uint32(int tag, uint value) => Field(tag, stackalloc byte[]
    {
        (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value
    });

    public Meta String(int tag, string text) => Field(tag, Encoding.UTF8.GetBytes(text));

    /// Closes the run with the terminator and appends the message, yielding the
    /// exact byte string that gets hashed.
    public byte[] Finish(ReadOnlySpan<byte> message = default)
    {
        var output = new byte[_bytes.Count + 1 + message.Length];
        _bytes.CopyTo(output);
        output[_bytes.Count] = 0xff;
        message.CopyTo(output.AsSpan(_bytes.Count + 1));
        return output;
    }

    /// The digest, not the metadata itself, is what AES-GCM takes as additional
    /// authenticated data.
    public byte[] Checksum(ReadOnlySpan<byte> message = default) => SHA256.HashData(Finish(message));

    public byte[] Hmac(byte[] key, ReadOnlySpan<byte> message = default) => HMACSHA256.HashData(key, Finish(message));
}
