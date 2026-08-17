// Construction and parsing of the messages a vehicle exchanges with a key.

using System.Security.Cryptography;
using System.Text;

namespace TeslaMock.Protocol;

public sealed class RoutableMessage
{
    public byte[] Raw = Array.Empty<byte>();
    public int? ToDomain;
    public byte[]? ToRoutingAddress;
    public int? FromDomain;
    public byte[]? FromRoutingAddress;
    public byte[]? Payload;
    public byte[]? SessionInfo;
    public byte[]? Uuid;
    public byte[]? RequestUuid;
    public uint Flags;
    public bool HasSessionInfoRequest;
    public byte[]? SessionInfoRequestPublicKey;
    public byte[]? SignerPublicKey;
    public CommandSignature? Signature;
}

public sealed class CommandSignature
{
    public byte[] Epoch = Array.Empty<byte>();
    public byte[] Nonce = Array.Empty<byte>();
    public uint Counter;
    public uint ExpiresAt;
    public byte[] Tag = Array.Empty<byte>();
}

public sealed class AddKeyRequest
{
    public ulong SignatureType;
    public byte[]? PublicKey;
    public ulong Role;
    public ulong FormFactor;
}

public static class Messages
{
    /// The vehicle advertises S<16 lowercase hex>C, where the hex is the first
    /// eight bytes of SHA-1 over the VIN. Scanning for this name is how one car
    /// is picked out without anyone storing its MAC address.
    public static string VehicleLocalName(string vin)
    {
        var digest = SHA1.HashData(Encoding.UTF8.GetBytes(vin));
        return "S" + Convert.ToHexString(digest, 0, 8).ToLowerInvariant() + "C";
    }

    private static PbWriter DestinationOf(int? domain, byte[]? routingAddress)
    {
        var writer = new PbWriter();
        if (domain.HasValue) writer.Varint(Protocol.Destination.DomainField, (ulong)domain.Value);
        if (routingAddress is not null) writer.Bytes(Protocol.Destination.RoutingAddress, routingAddress);
        return writer;
    }

    public static RoutableMessage ParseRoutable(byte[] bytes)
    {
        var fields = PbFields.Decode(bytes);
        var message = new RoutableMessage
        {
            Raw = bytes,
            Payload = fields.Bytes(Routable.ProtobufMessageAsBytes),
            SessionInfo = fields.Bytes(Routable.SessionInfo),
            Uuid = fields.Bytes(Routable.Uuid),
            RequestUuid = fields.Bytes(Routable.RequestUuid),
            Flags = (uint)(fields.Varint(Routable.Flags) ?? 0)
        };

        var to = fields.Message(Routable.ToDestination);
        if (to is not null)
        {
            var domain = to.Varint(Destination.DomainField);
            message.ToDomain = domain.HasValue ? (int)domain.Value : null;
            message.ToRoutingAddress = to.Bytes(Destination.RoutingAddress);
        }

        var from = fields.Message(Routable.FromDestination);
        if (from is not null)
        {
            var domain = from.Varint(Destination.DomainField);
            message.FromDomain = domain.HasValue ? (int)domain.Value : null;
            message.FromRoutingAddress = from.Bytes(Destination.RoutingAddress);
        }

        var request = fields.Message(Routable.SessionInfoRequest);
        if (request is not null)
        {
            message.HasSessionInfoRequest = true;
            message.SessionInfoRequestPublicKey = request.Bytes(SessionInfoRequest.PublicKey);
        }

        var signature = fields.Message(Routable.SignatureData);
        if (signature is not null)
        {
            var identity = signature.Message(SignatureData.SignerIdentity);
            if (identity is not null) message.SignerPublicKey = identity.Bytes(KeyIdentity.PublicKey);

            var gcm = signature.Message(SignatureData.AesGcmPersonalized);
            if (gcm is not null)
            {
                message.Signature = new CommandSignature
                {
                    Epoch = gcm.Bytes(AesGcmPersonalized.Epoch) ?? Array.Empty<byte>(),
                    Nonce = gcm.Bytes(AesGcmPersonalized.Nonce) ?? Array.Empty<byte>(),
                    Counter = (uint)(gcm.Varint(AesGcmPersonalized.Counter) ?? 0),
                    ExpiresAt = (uint)(gcm.Varint(AesGcmPersonalized.ExpiresAt) ?? 0),
                    Tag = gcm.Bytes(AesGcmPersonalized.Tag) ?? Array.Empty<byte>()
                };
            }
        }

        return message;
    }

    public static byte[] BuildSessionInfo(uint counter, byte[] publicKey, byte[] epoch, uint clockTime, int status)
    {
        var writer = new PbWriter();
        writer.Varint(SessionInfoField.Counter, counter);
        writer.Bytes(SessionInfoField.PublicKey, publicKey);
        writer.Bytes(SessionInfoField.Epoch, epoch);
        writer.Fixed32(SessionInfoField.ClockTime, clockTime);
        if (status != 0) writer.Varint(SessionInfoField.Status, (ulong)status);
        return writer.ToArray();
    }

    public static byte[] BuildSessionInfoResponse(int domain, byte[]? routingAddress, byte[] sessionInfo, byte[] tag, byte[]? requestUuid)
    {
        var hmacData = new PbWriter().Bytes(HmacSignatureData.Tag, tag);
        var signature = new PbWriter().Message(SignatureData.SessionInfoTag, hmacData);

        var message = new PbWriter();
        message.Message(Routable.ToDestination, DestinationOf(null, routingAddress));
        message.Message(Routable.FromDestination, DestinationOf(domain, null));
        message.Bytes(Routable.SessionInfo, sessionInfo);
        message.Message(Routable.SignatureData, signature);
        if (requestUuid is not null) message.Bytes(Routable.RequestUuid, requestUuid);
        return message.ToArray();
    }

    public sealed class ResponseSignature
    {
        public byte[] Nonce = Array.Empty<byte>();
        public uint Counter;
        public byte[] Tag = Array.Empty<byte>();
    }

    public static byte[] BuildCommandResponse(
        int domain,
        byte[]? routingAddress,
        byte[]? payload = null,
        int fault = 0,
        byte[]? sessionInfo = null,
        byte[]? sessionInfoTag = null,
        ResponseSignature? responseSignature = null,
        byte[]? requestUuid = null)
    {
        var message = new PbWriter();
        message.Message(Routable.ToDestination, DestinationOf(null, routingAddress));
        message.Message(Routable.FromDestination, DestinationOf(domain, null));
        if (payload is not null) message.Bytes(Routable.ProtobufMessageAsBytes, payload);

        if (fault != 0)
        {
            var status = new PbWriter();
            status.Varint(MessageStatus.OperationStatus, OperationStatus.Error);
            status.Varint(MessageStatus.SignedMessageFault, (ulong)fault);
            message.Message(Routable.SignedMessageStatus, status);
        }

        // signature_data is a oneof: an encrypted reply carries GCM parameters,
        // while a reply that only resyncs the session carries the session-info
        // HMAC proving the new epoch and counter came from the vehicle.
        if (responseSignature is not null)
        {
            var gcm = new PbWriter();
            gcm.Bytes(AesGcmResponse.Nonce, responseSignature.Nonce);
            gcm.Varint(AesGcmResponse.Counter, responseSignature.Counter);
            gcm.Bytes(AesGcmResponse.Tag, responseSignature.Tag);
            message.Message(Routable.SignatureData, new PbWriter().Message(SignatureData.AesGcmResponse, gcm));
        }
        else if (sessionInfoTag is not null)
        {
            var hmacData = new PbWriter().Bytes(HmacSignatureData.Tag, sessionInfoTag);
            message.Message(Routable.SignatureData, new PbWriter().Message(SignatureData.SessionInfoTag, hmacData));
        }

        if (sessionInfo is not null) message.Bytes(Routable.SessionInfo, sessionInfo);
        if (requestUuid is not null) message.Bytes(Routable.RequestUuid, requestUuid);
        return message.ToArray();
    }

    /// Tells an enrolment envelope (ToVCSECMessage) from a routable message. Two
    /// different top-level types share one transport, told apart by which field
    /// numbers are present.
    public static bool LooksLikeVcsecEnvelope(byte[] bytes)
    {
        try
        {
            var fields = PbFields.Decode(bytes);
            return fields.Has(ToVcsecMessage.SignedMessage)
                && !fields.Has(Routable.ToDestination)
                && !fields.Has(Routable.FromDestination);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    public static AddKeyRequest? ParseAddKeyRequest(byte[] bytes)
    {
        PbFields envelope;
        try
        {
            envelope = PbFields.Decode(bytes);
        }
        catch (FormatException)
        {
            return null;
        }

        var signed = envelope.Message(ToVcsecMessage.SignedMessage);
        if (signed is null) return null;

        var payload = signed.Bytes(VcsecSignedMessage.ProtobufMessageAsBytes);
        if (payload is null) return null;

        PbFields unsigned;
        try
        {
            unsigned = PbFields.Decode(payload);
        }
        catch (FormatException)
        {
            return null;
        }

        var operation = unsigned.Message(UnsignedMessage.WhitelistOperation);
        var permission = operation?.Message(WhitelistOperation.AddKeyToWhitelistAndAddPermissions);
        if (permission is null) return null;

        var key = permission.Message(PermissionChange.Key);
        var metadata = operation!.Message(WhitelistOperation.MetadataForKey);

        return new AddKeyRequest
        {
            SignatureType = signed.Varint(VcsecSignedMessage.SignatureType) ?? 0,
            PublicKey = key?.Bytes(PublicKeyField.PublicKeyRaw),
            Role = permission.Varint(PermissionChange.KeyRole) ?? 0,
            FormFactor = metadata?.Varint(KeyMetadata.KeyFormFactor) ?? 0
        };
    }

    // --- VCSEC payloads the vehicle sends back ---

    /// FromVCSECMessage.vehicleStatus (1) -> VehicleStatus, whose closureStatuses
    /// is itself field 1, so the frame opens 0a..0a.. -- exactly the nesting a
    /// client can get wrong by unwrapping only once.
    public static byte[] BuildVehicleStatus(IReadOnlyDictionary<int, int> closures, int lockState, int sleepStatus, int userPresence)
    {
        var closureStatuses = new PbWriter();
        foreach (var field in closures.Keys.OrderBy(k => k)) closureStatuses.Varint(field, (ulong)closures[field]);

        var status = new PbWriter();
        status.Message(VehicleStatusField.ClosureStatuses, closureStatuses);
        status.Varint(VehicleStatusField.VehicleLockState, (ulong)lockState);
        status.Varint(VehicleStatusField.VehicleSleepStatus, (ulong)sleepStatus);
        status.Varint(VehicleStatusField.UserPresence, (ulong)userPresence);

        return new PbWriter().Message(FromVcsecMessage.VehicleStatus, status).ToArray();
    }

    /// FromVCSECMessage.nominalError (46) -> NominalError.genericError (1).
    public static byte[] BuildNominalError(int code)
    {
        var inner = new PbWriter().Varint(1, (ulong)code);
        return new PbWriter().Message(FromVcsecMessage.NominalError, inner).ToArray();
    }

    public static byte[] BuildCommandStatus(int operationStatus)
    {
        var status = new PbWriter().Varint(CommandStatusField.OperationStatus, (ulong)operationStatus);
        return new PbWriter().Message(FromVcsecMessage.CommandStatus, status).ToArray();
    }
}
