// Wire constants, taken from Tesla's published vehicle-command SDK. Field
// numbers live here rather than in the message builders so a schema change has
// exactly one place to be corrected.

namespace TeslaMock.Protocol;

public static class Uuids
{
    public static readonly Guid Service = new("00000211-b2d1-43f0-9b88-960cebf8b91e");
    public static readonly Guid Write = new("00000212-b2d1-43f0-9b88-960cebf8b91e");
    public static readonly Guid Notify = new("00000213-b2d1-43f0-9b88-960cebf8b91e");
}

public static class Domain
{
    public const int Broadcast = 0;
    public const int VehicleSecurity = 2;
    public const int Infotainment = 3;
}

public static class SignatureType
{
    public const int AesGcmPersonalized = 5;
    public const int Hmac = 6;
    public const int AesGcmResponse = 9;
}

public static class Tag
{
    public const int SignatureType = 0;
    public const int Domain = 1;
    public const int Personalization = 2;
    public const int Epoch = 3;
    public const int ExpiresAt = 4;
    public const int Counter = 5;
    public const int Challenge = 6;
    public const int Flags = 7;
    public const int RequestHash = 8;
    public const int Fault = 9;
}

public static class Labels
{
    // Byte-exact; a stray character silently breaks authentication.
    public const string SessionInfo = "session info";
    public const string MessageAuth = "authenticated command";
}

public static class Routable
{
    public const int ToDestination = 6;
    public const int FromDestination = 7;
    public const int ProtobufMessageAsBytes = 10;
    public const int SignedMessageStatus = 12;
    public const int SignatureData = 13;
    public const int SessionInfoRequest = 14;
    public const int SessionInfo = 15;
    public const int RequestUuid = 50;
    public const int Uuid = 51;
    public const int Flags = 52;
}

public static class Destination
{
    public const int DomainField = 1;
    public const int RoutingAddress = 2;
}

public static class SessionInfoRequest
{
    public const int PublicKey = 1;
    public const int Challenge = 2;
}

public static class SessionInfoField
{
    public const int Counter = 1;
    public const int PublicKey = 2;
    public const int Epoch = 3;
    public const int ClockTime = 4;
    public const int Status = 5;
}

public static class SessionInfoStatus
{
    public const int Ok = 0;
    public const int KeyNotOnWhitelist = 1;
}

public static class SignatureData
{
    public const int SignerIdentity = 1;
    public const int AesGcmPersonalized = 5;
    public const int SessionInfoTag = 6;
    public const int AesGcmResponse = 9;
}

public static class KeyIdentity
{
    public const int PublicKey = 1;
}

public static class AesGcmPersonalized
{
    public const int Epoch = 1;
    public const int Nonce = 2;
    public const int Counter = 3;
    public const int ExpiresAt = 4;
    public const int Tag = 5;
}

public static class AesGcmResponse
{
    public const int Nonce = 1;
    public const int Counter = 2;
    public const int Tag = 3;
}

public static class HmacSignatureData
{
    public const int Tag = 1;
}

public static class MessageStatus
{
    public const int OperationStatus = 1;
    public const int SignedMessageFault = 2;
}

public static class OperationStatus
{
    public const int Ok = 0;
    public const int Wait = 1;
    public const int Error = 2;
}

public static class UnsignedMessage
{
    public const int InformationRequest = 1;
    public const int RkeAction = 2;
    public const int ClosureMoveRequest = 4;
    public const int WhitelistOperation = 16;
}

public static class RkeAction
{
    public const int Unlock = 0;
    public const int Lock = 1;
    public const int RemoteDrive = 20;
    public const int AutoSecureVehicle = 29;
    public const int WakeVehicle = 30;
}

public static class ClosureMove
{
    public const int None = 0;
    public const int Move = 1;
    public const int Stop = 2;
    public const int Open = 3;
    public const int Close = 4;
}

public static class ClosureField
{
    public const int FrontDriverDoor = 1;
    public const int FrontPassengerDoor = 2;
    public const int RearDriverDoor = 3;
    public const int RearPassengerDoor = 4;
    public const int RearTrunk = 5;
    public const int FrontTrunk = 6;
    public const int ChargePort = 7;
    public const int Tonneau = 8;

    public static string Name(int field) => field switch
    {
        FrontDriverDoor => "front driver door",
        FrontPassengerDoor => "front passenger door",
        RearDriverDoor => "rear driver door",
        RearPassengerDoor => "rear passenger door",
        RearTrunk => "trunk",
        FrontTrunk => "frunk",
        ChargePort => "charge port",
        Tonneau => "tonneau",
        _ => $"closure {field}"
    };
}

public static class WhitelistOperation
{
    public const int AddKeyToWhitelistAndAddPermissions = 5;
    public const int MetadataForKey = 6;
}

public static class PermissionChange
{
    public const int Key = 1;
    public const int SecondsToBeActive = 3;
    public const int KeyRole = 4;
}

public static class PublicKeyField
{
    public const int PublicKeyRaw = 1;
}

public static class KeyMetadata
{
    public const int KeyFormFactor = 1;
}

public static class Role
{
    public static string Name(ulong role) => role switch
    {
        0 => "none",
        1 => "service",
        2 => "owner",
        3 => "driver",
        4 => "fm",
        5 => "vehicle monitor",
        6 => "charging manager",
        8 => "guest",
        _ => $"role {role}"
    };
}

public static class KeyFormFactor
{
    public static string Name(ulong formFactor) => formFactor switch
    {
        0 => "unknown",
        1 => "NFC card",
        6 => "iOS device",
        7 => "Android device",
        9 => "cloud key",
        _ => $"form factor {formFactor}"
    };
}

public static class ToVcsecMessage
{
    public const int SignedMessage = 1;
}

public static class VcsecSignedMessage
{
    public const int ProtobufMessageAsBytes = 2;
    public const int SignatureType = 3;
}

public static class VcsecSignatureType
{
    public const int None = 0;
    public const int PresentKey = 2;
}

public static class FromVcsecMessage
{
    public const int VehicleStatus = 1;
    public const int CommandStatus = 4;
    public const int WhitelistInfo = 16;
    public const int WhitelistEntryInfo = 17;
    public const int NominalError = 46;
}

public static class VehicleStatusField
{
    public const int ClosureStatuses = 1;
    public const int VehicleLockState = 2;
    public const int VehicleSleepStatus = 3;
    public const int UserPresence = 4;
}

public static class CommandStatusField
{
    public const int OperationStatus = 1;
    public const int SignedMessageStatus = 2;
    public const int WhitelistOperationStatus = 3;
}

public static class ClosureState
{
    public const int Closed = 0;
    public const int Open = 1;
    public const int Ajar = 2;
    public const int Unknown = 3;
    public const int FailedUnlatch = 4;
    public const int Opening = 5;
    public const int Closing = 6;

    public static string Name(int state) => state switch
    {
        Closed => "closed",
        Open => "open",
        Ajar => "ajar",
        Unknown => "unknown",
        FailedUnlatch => "failed to unlatch",
        Opening => "opening",
        Closing => "closing",
        _ => "unknown"
    };
}

public static class LockState
{
    public const int Unlocked = 0;
    public const int Locked = 1;
    public const int InternalLocked = 2;
    public const int SelectiveUnlocked = 3;

    public static string Name(int state) => state switch
    {
        Unlocked => "unlocked",
        Locked => "locked",
        InternalLocked => "locked from inside",
        SelectiveUnlocked => "partly unlocked",
        _ => "unknown"
    };
}

/// SignedMessage faults, as sent back in signedMessageStatus.
public static class Fault
{
    public const int None = 0;
    public const int UnknownKeyId = 3;
    public const int InactiveKey = 4;
    public const int InvalidSignature = 5;
    public const int InvalidTokenOrCounter = 6;
    public const int InsufficientPrivileges = 7;
    public const int IncorrectEpoch = 15;
    public const int TimeExpired = 17;
    public const int RepeatedCounter = 26;

    public static string Name(int fault) => fault switch
    {
        None => "none",
        UnknownKeyId => "unknown key id",
        InactiveKey => "inactive key",
        InvalidSignature => "invalid signature",
        InvalidTokenOrCounter => "invalid token or counter",
        InsufficientPrivileges => "insufficient privileges",
        IncorrectEpoch => "incorrect epoch",
        TimeExpired => "time expired",
        RepeatedCounter => "repeated counter",
        _ => $"fault {fault}"
    };
}

/// Errors.GenericError_E, returned in FromVCSECMessage.nominalError: the vehicle
/// declining for a physical reason rather than a protocol fault.
public static class GenericError
{
    public const int None = 0;
    public const int Unknown = 1;
    public const int ClosuresOpen = 2;
    public const int AlreadyOn = 3;
    public const int DisabledForUserCommand = 4;
    public const int VehicleNotInPark = 5;
    public const int Unauthorized = 6;
    public const int NotAllowedOverTransport = 7;
}
