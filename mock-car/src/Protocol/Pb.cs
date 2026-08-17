// Minimal protobuf wire-format codec.
//
// A deliberate re-implementation rather than generated code: the point of this
// program is to be a second opinion on the watch's encoder, and generating both
// sides from the same .proto would only prove they agree with each other. The
// four wire types are all Tesla's key-fob messages use.

namespace TeslaMock.Protocol;

public sealed class PbWriter
{
    private readonly List<byte> _bytes = new();

    public int Length => _bytes.Count;

    private static void PushVarint(List<byte> into, ulong value)
    {
        while (value >= 0x80)
        {
            into.Add((byte)((value & 0x7f) | 0x80));
            value >>= 7;
        }
        into.Add((byte)value);
    }

    private void Tag(int field, int wireType) => PushVarint(_bytes, ((ulong)field << 3) | (uint)wireType);

    public PbWriter Varint(int field, ulong value)
    {
        Tag(field, 0);
        PushVarint(_bytes, value);
        return this;
    }

    // Wire type 5 is little-endian, while the same numbers appear big-endian in
    // the signature metadata. Mixing the two produces a message that looks valid
    // and authenticates to nothing.
    public PbWriter Fixed32(int field, uint value)
    {
        Tag(field, 5);
        _bytes.Add((byte)value);
        _bytes.Add((byte)(value >> 8));
        _bytes.Add((byte)(value >> 16));
        _bytes.Add((byte)(value >> 24));
        return this;
    }

    public PbWriter Bytes(int field, ReadOnlySpan<byte> value)
    {
        Tag(field, 2);
        PushVarint(_bytes, (ulong)value.Length);
        foreach (var b in value) _bytes.Add(b);
        return this;
    }

    public PbWriter Message(int field, PbWriter sub) => Bytes(field, sub.ToArray());

    // Presence is meaningful: several Tesla messages are empty markers whose
    // existence selects a variant of a oneof.
    public PbWriter EmptyMessage(int field) => Bytes(field, ReadOnlySpan<byte>.Empty);

    public byte[] ToArray() => _bytes.ToArray();
}

/// Decoded fields, keyed by field number. Repeated fields fall out naturally and
/// unknown fields are kept rather than dropped, so a frame can be inspected
/// without a schema.
public sealed class PbFields
{
    private readonly Dictionary<int, List<object>> _fields = new();

    public IEnumerable<int> FieldNumbers => _fields.Keys;

    public bool Has(int field) => _fields.ContainsKey(field);

    public static PbFields Decode(byte[] bytes)
    {
        var result = new PbFields();
        var pos = 0;

        while (pos < bytes.Length)
        {
            var tag = ReadVarint(bytes, ref pos);
            var field = (int)(tag >> 3);
            var wireType = (int)(tag & 7);
            if (field == 0) throw new FormatException("protobuf: zero field number");

            switch (wireType)
            {
                case 0:
                    result.Put(field, ReadVarint(bytes, ref pos));
                    break;
                case 2:
                {
                    var length = (int)ReadVarint(bytes, ref pos);
                    if (length < 0 || pos + length > bytes.Length) throw new FormatException("protobuf: truncated field");
                    result.Put(field, bytes.AsSpan(pos, length).ToArray());
                    pos += length;
                    break;
                }
                case 5:
                {
                    if (pos + 4 > bytes.Length) throw new FormatException("protobuf: truncated fixed32");
                    ulong value = bytes[pos] | ((ulong)bytes[pos + 1] << 8) | ((ulong)bytes[pos + 2] << 16) | ((ulong)bytes[pos + 3] << 24);
                    result.Put(field, value);
                    pos += 4;
                    break;
                }
                case 1:
                {
                    if (pos + 8 > bytes.Length) throw new FormatException("protobuf: truncated fixed64");
                    result.Put(field, bytes.AsSpan(pos, 8).ToArray());
                    pos += 8;
                    break;
                }
                default:
                    throw new FormatException($"protobuf: unsupported wire type {wireType}");
            }
        }

        return result;
    }

    private static ulong ReadVarint(byte[] bytes, ref int pos)
    {
        ulong value = 0;
        var shift = 0;
        while (pos < bytes.Length)
        {
            var b = bytes[pos++];
            value |= (ulong)(b & 0x7f) << shift;
            if ((b & 0x80) == 0) return value;
            shift += 7;
            if (shift > 63) throw new FormatException("protobuf: varint too long");
        }
        throw new FormatException("protobuf: truncated varint");
    }

    private void Put(int field, object value)
    {
        if (!_fields.TryGetValue(field, out var list))
        {
            list = new List<object>();
            _fields[field] = list;
        }
        list.Add(value);
    }

    public ulong? Varint(int field)
    {
        if (!_fields.TryGetValue(field, out var values)) return null;
        return values[0] as ulong? ?? null;
    }

    public byte[]? Bytes(int field)
    {
        if (!_fields.TryGetValue(field, out var values)) return null;
        return values[0] as byte[];
    }

    public PbFields? Message(int field)
    {
        var raw = Bytes(field);
        if (raw is null) return null;
        try
        {
            return Decode(raw);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
