// A stand-in Tesla that speaks the real protocol.
//
// Two deliberate choices make this a genuine test of a key rather than a mirror
// of one: every cryptographic operation runs through .NET's own primitives, so
// an ECDH, AES-GCM or HMAC bug on the key's side shows up as a mismatch instead
// of cancelling out; and the signature metadata is encoded here independently,
// because a shared encoder with the TLV layout wrong would agree with itself.
//
// It also enforces what a real car enforces -- whitelist membership, epoch,
// strictly increasing counters, expiry -- so the rejection paths get exercised
// without a vehicle present.

using System.Security.Cryptography;
using System.Text;
using TeslaMock.Protocol;

namespace TeslaMock.Vehicle;

public sealed record VehicleSnapshot(
    string Vin,
    string LocalName,
    int LockState,
    IReadOnlyDictionary<int, int> Closures,
    bool Awake,
    int EnrolledKeys,
    bool EnrolmentPending,
    string EpochHex,
    uint Clock,
    uint Counter);

public sealed class VirtualVehicle
{
    private readonly object _gate = new();
    private readonly ECDiffieHellman _key;
    private readonly byte[] _vinBytes;
    private readonly Dictionary<string, EnrolledKey> _whitelist = new();
    private readonly Dictionary<int, DomainState> _domains = new();
    private readonly Dictionary<int, Timer> _motion = new();
    private readonly Dictionary<int, int> _closures = new()
    {
        [ClosureField.FrontDriverDoor] = ClosureState.Closed,
        [ClosureField.FrontPassengerDoor] = ClosureState.Closed,
        [ClosureField.RearDriverDoor] = ClosureState.Closed,
        [ClosureField.RearPassengerDoor] = ClosureState.Closed,
        [ClosureField.RearTrunk] = ClosureState.Closed,
        [ClosureField.FrontTrunk] = ClosureState.Closed,
        [ClosureField.ChargePort] = ClosureState.Closed
    };

    private byte[] _epoch;
    private int _lockState = LockState.Locked;
    private bool _awake;
    private bool _injectCounterFault;
    private AddKeyRequest? _pendingEnrolment;
    private readonly DateTime _bootedAt = DateTime.UtcNow;
    private uint _clockBase;

    public string Vin { get; }
    public string LocalName { get; }
    public byte[] PublicKey { get; }

    /// How long a powered closure takes to finish moving. Real hardware is not
    /// instant, and a client that treats "sent" as "done" should be able to see
    /// that on the status it reads back.
    public int MotionMs { get; init; } = 2000;

    /// Model 3 and Y have a powered liftgate; many cars do not, and those ignore
    /// a trunk-close silently rather than reporting anything.
    public bool PoweredLiftgate { get; set; } = true;

    /// Approve enrolment without waiting for a keycard tap. Only for unattended
    /// runs -- the tap is the whole security model, so it is off by default.
    public bool AutoTap { get; set; }

    /// Push an unsolicited VehicleStatus after every state change, the way a real
    /// car does. Those frames are unauthenticated, so a client should treat them
    /// as overheard rather than trusted.
    public bool BroadcastStatusChanges { get; set; }

    public Action<byte[]>? Send { get; set; }
    public Action<string, string>? Log { get; set; }
    public Action? StateChanged { get; set; }

    public VirtualVehicle(string vin, VehicleStore.State? restored)
    {
        Vin = vin;
        LocalName = Messages.VehicleLocalName(vin);
        _vinBytes = Encoding.UTF8.GetBytes(vin);

        if (restored?.PrivateKey is { Length: > 0 } saved)
        {
            _key = ECDiffieHellman.Create();
            _key.ImportECPrivateKey(Convert.FromBase64String(saved), out _);
        }
        else
        {
            _key = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        }

        _epoch = restored?.Epoch is { Length: > 0 } epoch ? Convert.FromHexString(epoch) : RandomNumberGenerator.GetBytes(16);
        _clockBase = restored?.Clock ?? 0;
        if (restored?.LockState is int lockState) _lockState = lockState;

        if (restored?.Keys is not null)
        {
            foreach (var entry in restored.Keys)
                _whitelist[entry.PublicKey.ToLowerInvariant()] = new EnrolledKey(entry.Role, entry.FormFactor, entry.AddedUtc);
        }

        if (restored?.Counters is not null)
        {
            foreach (var pair in restored.Counters)
                _domains[int.Parse(pair.Key)] = new DomainState { Counter = pair.Value };
        }

        var parameters = _key.PublicKey.ExportParameters();
        PublicKey = new byte[65];
        PublicKey[0] = 0x04;
        parameters.Q.X!.CopyTo(PublicKey, 1);
        parameters.Q.Y!.CopyTo(PublicKey, 33);
    }

    private sealed record EnrolledKey(ulong Role, ulong FormFactor, DateTime AddedUtc);

    private sealed class DomainState
    {
        public uint Counter;
        public uint ResponseCounter;
    }

    private uint Clock => _clockBase + (uint)(DateTime.UtcNow - _bootedAt).TotalSeconds;

    private DomainState DomainFor(int domain)
    {
        if (!_domains.TryGetValue(domain, out var state))
        {
            state = new DomainState();
            _domains[domain] = state;
        }
        return state;
    }

    // --- inbound ---

    public void Receive(byte[] bytes)
    {
        lock (_gate)
        {
            try
            {
                ReceiveLocked(bytes);
            }
            catch (Exception e)
            {
                Log?.Invoke("error", "while handling a message: " + e.Message);
            }
        }
    }

    private void ReceiveLocked(byte[] bytes)
    {
        // Every inbound message announced, not just the malformed ones. A key
        // that dies is diagnosed from the last thing it managed to say as much
        // as from the last thing it was told, and at normal verbosity the
        // successful cases were the ones that said nothing.
        Log2(Verbosity.Verbose, "rx", $"a complete message of {bytes.Length} bytes" +
                                      (Trace.Enabled(Verbosity.Trace) ? "  " + Trace.Hex(bytes) : ""));

        if (Messages.LooksLikeVcsecEnvelope(bytes))
        {
            Log2(Verbosity.Verbose, "rx", "it is an unsigned VCSEC envelope — an enrolment request");
            HandleEnrolment(bytes);
            return;
        }

        RoutableMessage message;
        try
        {
            message = Messages.ParseRoutable(bytes);
        }
        catch (FormatException e)
        {
            Log?.Invoke("rx", "undecodable message: " + e.Message);
            return;
        }

        if (message.ToDomain is null)
        {
            Log?.Invoke("rx", "message with no destination domain, ignored");
            return;
        }

        if (message.HasSessionInfoRequest)
        {
            Log2(Verbosity.Verbose, "rx", $"it is a handshake request for domain {message.ToDomain}");
            HandleHandshake(message);
        }
        else if (message.Signature is not null)
        {
            Log2(Verbosity.Verbose, "rx", $"it is a signed command for domain {message.ToDomain}" +
                                          $", counter {message.Signature.Counter}");
            HandleCommand(message);
        }
        else Log?.Invoke("rx", "message that is neither a handshake nor a signed command");
    }

    /// A log line that only exists above a verbosity level.
    private void Log2(Verbosity level, string category, string text)
    {
        if (!Trace.Enabled(level)) return;
        Log?.Invoke(category, text);
    }

    private void HandleEnrolment(byte[] bytes)
    {
        var request = Messages.ParseAddKeyRequest(bytes);
        if (request is null || request.PublicKey is null || request.PublicKey.Length != 65)
        {
            Log?.Invoke("rx", "malformed enrolment request");
            return;
        }
        if (request.SignatureType != VcsecSignatureType.PresentKey)
        {
            Log?.Invoke("rx", $"enrolment request with signature type {request.SignatureType}, expected PRESENT_KEY");
            return;
        }

        var id = Convert.ToHexString(request.PublicKey).ToLowerInvariant();
        if (_whitelist.ContainsKey(id))
        {
            Log?.Invoke("enrol", "that key is already enrolled");
            Emit(Messages.BuildCommandStatus(OperationStatus.Ok), "an enrolment acknowledgement");
            return;
        }

        // A real vehicle waits here for the owner to tap an enrolled NFC keycard
        // on the centre console. Nothing the requester sends can substitute for
        // that, which is the whole reason an unauthenticated request is safe.
        _pendingEnrolment = request;
        Log?.Invoke("enrol", $"key {id[..16]}… asks to be added as {Role.Name(request.Role)} " +
                             $"({KeyFormFactor.Name(request.FormFactor)})");
        Log?.Invoke("enrol", AutoTap ? "auto-tap is on; approving" : "waiting for a keycard tap  [press k]");
        Emit(Messages.BuildCommandStatus(OperationStatus.Wait), "the enrolment WAIT status");
        StateChanged?.Invoke();

        if (AutoTap) TapKeycardLocked();
    }

    private void HandleHandshake(RoutableMessage message)
    {
        var clientPublicKey = message.SessionInfoRequestPublicKey;
        if (clientPublicKey is null || clientPublicKey.Length != 65)
        {
            Log?.Invoke("rx", "handshake with a malformed public key");
            return;
        }

        var id = Convert.ToHexString(clientPublicKey).ToLowerInvariant();
        var enrolled = _whitelist.ContainsKey(id);

        byte[]? sessionKey;
        try
        {
            sessionKey = SessionKeyFor(clientPublicKey);
        }
        catch (CryptographicException)
        {
            Log?.Invoke("rx", "handshake public key is not a point on P-256");
            return;
        }

        var domain = message.ToDomain!.Value;
        var info = SessionInfoFor(enrolled, DomainFor(domain).Counter);
        var tag = SessionInfoTag(sessionKey, message.Uuid, info);

        Log?.Invoke("session", $"handshake from {(enrolled ? "an enrolled key" : "an UNKNOWN key")} {id[..16]}… " +
                               $"on domain {domain}");

        // Named explicitly because of what it costs the key. This reply is
        // what a key turns into a session key, and deriving one is the single
        // most expensive thing in the protocol -- the step that once ran inside
        // a Zepp notification callback for 87 seconds and reset the watch. If a
        // key is going to disappear, it disappears after this line.
        Emit(Messages.BuildSessionInfoResponse(domain, message.FromRoutingAddress, info, tag, message.Uuid),
            "the handshake reply (session info: the key now has to derive a session key from it)");
    }

    private void HandleCommand(RoutableMessage message)
    {
        var domain = message.ToDomain!.Value;
        var signature = message.Signature!;
        var state = DomainFor(domain);

        var publicKey = message.SignerPublicKey;
        var id = publicKey is null || publicKey.Length != 65
            ? null
            : Convert.ToHexString(publicKey).ToLowerInvariant();

        // The session key comes from ECDH with whatever key signed the message,
        // which works whether or not that key is enrolled. Deriving it even for
        // a stranger is what lets the fault reply below carry an authenticated
        // session_info: a client is right to refuse unauthenticated session
        // info, and a car that sent some would look to it like an attacker
        // trying to stall it, rather than like a car saying "I don't know you".
        byte[]? sessionKey = null;
        if (id is not null)
        {
            try
            {
                sessionKey = SessionKeyFor(publicKey!);
            }
            catch (CryptographicException)
            {
                Log?.Invoke("reject", "the signing key is not a point on P-256");
            }
        }

        if (id is null || !_whitelist.ContainsKey(id))
        {
            Log?.Invoke("reject", "command from a key that is not on the whitelist");
            RespondWithFault(message, Fault.UnknownKeyId, sessionKey, enrolled: false);
            return;
        }
        if (sessionKey is null)
        {
            RespondWithFault(message, Fault.InvalidSignature, null);
            return;
        }

        if (!signature.Epoch.AsSpan().SequenceEqual(_epoch))
        {
            Log?.Invoke("reject", "wrong epoch — the car has rebooted since this session opened");
            RespondWithFault(message, Fault.IncorrectEpoch, sessionKey);
            return;
        }
        if (_injectCounterFault || signature.Counter <= state.Counter)
        {
            _injectCounterFault = false;
            Log?.Invoke("reject", $"counter {signature.Counter} is not ahead of {state.Counter}");
            RespondWithFault(message, Fault.RepeatedCounter, sessionKey);
            return;
        }
        var clock = Clock;
        if (signature.ExpiresAt < clock)
        {
            Log?.Invoke("reject", $"expired at {signature.ExpiresAt}, car clock is {clock}");
            RespondWithFault(message, Fault.TimeExpired, sessionKey);
            return;
        }

        byte[] plaintext;
        try
        {
            var aad = CommandAad(domain, signature.Counter, signature.ExpiresAt, message.Flags);
            plaintext = new byte[message.Payload?.Length ?? 0];
            using var gcm = new AesGcm(sessionKey, 16);
            gcm.Decrypt(signature.Nonce, message.Payload ?? Array.Empty<byte>(), signature.Tag, plaintext, aad);
        }
        catch (CryptographicException)
        {
            Log?.Invoke("reject", "the command did not authenticate");
            RespondWithFault(message, Fault.InvalidSignature, sessionKey);
            return;
        }

        state.Counter = signature.Counter;
        Execute(message, sessionKey, plaintext);
    }

    private void Execute(RoutableMessage message, byte[] sessionKey, byte[] plaintext)
    {
        PbFields action;
        try
        {
            action = PbFields.Decode(plaintext);
        }
        catch (FormatException)
        {
            Log?.Invoke("reject", "the decrypted command is not a VCSEC message");
            SendVcsecPayload(message, sessionKey, Messages.BuildNominalError(GenericError.Unknown));
            return;
        }

        if (action.Has(UnsignedMessage.InformationRequest))
        {
            Log?.Invoke("cmd", "status requested");
            SendVcsecPayload(message, sessionKey, BuildStatusPayload());
            return;
        }

        var rke = action.Varint(UnsignedMessage.RkeAction);
        if (rke.HasValue)
        {
            switch ((int)rke.Value)
            {
                case RkeAction.Unlock:
                    _lockState = LockState.Unlocked;
                    _awake = true;
                    Log?.Invoke("cmd", "UNLOCK");
                    break;

                case RkeAction.Lock:
                case RkeAction.AutoSecureVehicle:
                    // A real car refuses to lock while something is standing
                    // open, and says so with CLOSURES_OPEN rather than failing
                    // silently.
                    if (AnythingOpen())
                    {
                        Log?.Invoke("cmd", "LOCK refused — something is still open");
                        SendVcsecPayload(message, sessionKey, Messages.BuildNominalError(GenericError.ClosuresOpen));
                        return;
                    }
                    _lockState = LockState.Locked;
                    Log?.Invoke("cmd", "LOCK");
                    break;

                case RkeAction.WakeVehicle:
                    _awake = true;
                    Log?.Invoke("cmd", "WAKE");
                    break;

                default:
                    Log?.Invoke("cmd", $"RKE action {rke.Value}");
                    break;
            }

            Acknowledge(message, sessionKey);
            Changed();
            return;
        }

        var closure = action.Message(UnsignedMessage.ClosureMoveRequest);
        if (closure is not null)
        {
            var moved = false;
            // A request may actuate several closures, so every field present is
            // acted on rather than just the first.
            foreach (var field in closure.FieldNumbers.OrderBy(f => f))
            {
                var move = (int)(closure.Varint(field) ?? 0);
                moved |= MoveClosure(field, move);
            }
            if (!moved) Log?.Invoke("cmd", "closure request the car has no hardware for; ignored");
            Acknowledge(message, sessionKey);
            Changed();
            return;
        }

        Log?.Invoke("cmd", "a command this car does not implement; acknowledged anyway");
        Acknowledge(message, sessionKey);
    }

    private bool MoveClosure(int field, int move)
    {
        if (!_closures.ContainsKey(field))
        {
            Log?.Invoke("cmd", $"{ClosureField.Name(field)} is not fitted");
            return false;
        }

        switch (move)
        {
            case ClosureMove.Open:
            case ClosureMove.Move:
                Log?.Invoke("cmd", $"{ClosureField.Name(field)}: open");
                // A door or the frunk pops its latch; the driver still has to
                // lift it. Powered panels travel.
                if (field is ClosureField.FrontTrunk or ClosureField.ChargePort ||
                    field <= ClosureField.RearPassengerDoor)
                {
                    SetClosure(field, ClosureState.Open);
                    if (field <= ClosureField.RearPassengerDoor) _lockState = LockState.Unlocked;
                }
                else
                {
                    StartMotion(field, ClosureState.Opening, ClosureState.Open);
                }
                return true;

            case ClosureMove.Close:
                if (field == ClosureField.RearTrunk && !PoweredLiftgate)
                {
                    // Silently ignored on a car without the motor, which is
                    // exactly what a real one does.
                    Log?.Invoke("cmd", "trunk close ignored — this car has no powered liftgate");
                    return true;
                }
                if (field == ClosureField.FrontTrunk)
                {
                    // No Tesla can close a frunk remotely.
                    Log?.Invoke("cmd", "frunk close ignored — no Tesla can do that remotely");
                    return true;
                }
                Log?.Invoke("cmd", $"{ClosureField.Name(field)}: close");
                if (field == ClosureField.ChargePort) SetClosure(field, ClosureState.Closed);
                else StartMotion(field, ClosureState.Closing, ClosureState.Closed);
                return true;

            case ClosureMove.Stop:
                var current = _closures[field];
                Log?.Invoke("cmd", $"{ClosureField.Name(field)}: stop");
                if (current is ClosureState.Opening or ClosureState.Closing)
                {
                    CancelMotion(field);
                    SetClosure(field, ClosureState.Ajar);
                }
                return true;

            default:
                return false;
        }
    }

    private void StartMotion(int field, int moving, int settled)
    {
        CancelMotion(field);
        SetClosure(field, moving);
        if (MotionMs <= 0)
        {
            SetClosure(field, settled);
            return;
        }

        _motion[field] = new Timer(_ =>
        {
            lock (_gate)
            {
                if (_closures.TryGetValue(field, out var state) && state == moving)
                {
                    SetClosure(field, settled);
                    Log?.Invoke("car", $"{ClosureField.Name(field)} is now {ClosureState.Name(settled)}");
                    Changed();
                }
                CancelMotion(field);
            }
        }, null, MotionMs, Timeout.Infinite);
    }

    private void CancelMotion(int field)
    {
        if (_motion.Remove(field, out var timer)) timer.Dispose();
    }

    private void SetClosure(int field, int state) => _closures[field] = state;

    private bool AnythingOpen() =>
        _closures.Any(pair => pair.Key != ClosureField.ChargePort &&
                              pair.Value is not (ClosureState.Closed or ClosureState.Unknown));

    // --- replies ---

    private void Acknowledge(RoutableMessage message, byte[] sessionKey)
    {
        // VCSEC acknowledges success by saying nothing: an empty
        // FromVCSECMessage is the acknowledgement.
        SendVcsecPayload(message, sessionKey, Array.Empty<byte>());
    }

    /// Sends a VCSEC payload back, encrypting it when the request asked for an
    /// encrypted reply, so error paths take the same route as successful ones.
    private void SendVcsecPayload(RoutableMessage message, byte[] sessionKey, byte[] payload)
    {
        var domain = message.ToDomain!.Value;
        var state = DomainFor(domain);
        var signature = message.Signature!;

        if ((message.Flags & 2) != 0)
        {
            state.ResponseCounter += 1;
            var nonce = RandomNumberGenerator.GetBytes(12);
            var ciphertext = new byte[payload.Length];
            var tag = new byte[16];
            var aad = ResponseAad(domain, state.ResponseCounter, 0, RequestHash(signature.Tag), 0);
            using (var gcm = new AesGcm(sessionKey, 16))
            {
                gcm.Encrypt(nonce, payload, ciphertext, tag, aad);
            }

            Emit(Messages.BuildCommandResponse(
                domain,
                message.FromRoutingAddress,
                payload: ciphertext,
                responseSignature: new Messages.ResponseSignature { Nonce = nonce, Counter = state.ResponseCounter, Tag = tag },
                requestUuid: message.Uuid),
                "an encrypted command response (the key must decrypt and verify it)");
            return;
        }

        Emit(Messages.BuildCommandResponse(domain, message.FromRoutingAddress, payload: payload, requestUuid: message.Uuid),
            "a plain command response");
    }

    /// `enrolled` is what the attached session info reports, and it is not the
    /// same question as whether a session key could be derived: a stranger's key
    /// derives perfectly well and is still not on the whitelist.
    private void RespondWithFault(RoutableMessage message, int fault, byte[]? sessionKey, bool enrolled = true)
    {
        var domain = message.ToDomain!.Value;
        var info = SessionInfoFor(enrolled, DomainFor(domain).Counter);

        Emit(Messages.BuildCommandResponse(
            domain,
            message.FromRoutingAddress,
            fault: fault,
            sessionInfo: info,
            // The attached session info has to be authenticated, or a bystander
            // could feed the key a forged epoch and counter and stall it.
            sessionInfoTag: sessionKey is null ? null : SessionInfoTag(sessionKey, message.Uuid, info),
            requestUuid: message.Uuid),
            $"a fault ({Fault.Name(fault)}) with fresh session info attached");
    }

    /// Hands a reply to the link, having first said what it is.
    ///
    /// `what` is not decoration. When a key stops answering, the question is
    /// always "what had it just been given?", and the bytes on their own do not
    /// answer it -- the reply that has historically been fatal, session info,
    /// looks like any other short message on the wire. Recorded before the send
    /// so that a burst which never finishes is still attributed to it.
    private void Emit(byte[] message, string what = "a reply")
    {
        Trace.Sending($"{what} ({message.Length} bytes)");

        var send = Send;
        if (send is null)
        {
            Log?.Invoke("tx", $"nothing is connected; {what} dropped");
            return;
        }

        Log?.Invoke("tx", $"sending {what}, {message.Length} bytes" +
                          (Trace.Enabled(Verbosity.Trace) ? "  " + Trace.Hex(message) : ""));
        send(message);
    }

    private byte[] BuildStatusPayload() =>
        Messages.BuildVehicleStatus(_closures, _lockState, _awake ? 1 : 2, 1);

    // --- cryptography ---

    private byte[] SessionKeyFor(byte[] clientPublicKey)
    {
        var parameters = new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint
            {
                X = clientPublicKey.AsSpan(1, 32).ToArray(),
                Y = clientPublicKey.AsSpan(33, 32).ToArray()
            }
        };
        parameters.Validate();

        using var peer = ECDiffieHellman.Create(parameters);
        var sharedX = _key.DeriveRawSecretAgreement(peer.PublicKey);
        return SHA1.HashData(sharedX).AsSpan(0, 16).ToArray();
    }

    private byte[] SessionInfoFor(bool enrolled, uint counter) =>
        Messages.BuildSessionInfo(
            counter,
            PublicKey,
            _epoch,
            Clock,
            enrolled ? SessionInfoStatus.Ok : SessionInfoStatus.KeyNotOnWhitelist);

    private byte[] SessionInfoTag(byte[] sessionKey, byte[]? challenge, byte[] rawSessionInfo)
    {
        var meta = new Meta()
            .Byte(Tag.SignatureType, SignatureType.Hmac)
            .Field(Tag.Personalization, _vinBytes);
        if (challenge is { Length: > 0 }) meta.Field(Tag.Challenge, challenge);

        var subkey = HMACSHA256.HashData(sessionKey, Encoding.UTF8.GetBytes(Labels.SessionInfo));
        return meta.Hmac(subkey, rawSessionInfo);
    }

    private byte[] CommandAad(int domain, uint counter, uint expiresAt, uint flags)
    {
        var meta = new Meta()
            .Byte(Tag.SignatureType, SignatureType.AesGcmPersonalized)
            .Byte(Tag.Domain, (byte)domain)
            .Field(Tag.Personalization, _vinBytes)
            .Field(Tag.Epoch, _epoch)
            .Uint32(Tag.ExpiresAt, expiresAt)
            .Uint32(Tag.Counter, counter);
        if (flags > 0) meta.Uint32(Tag.Flags, flags);
        return meta.Checksum();
    }

    private byte[] ResponseAad(int domain, uint counter, uint flags, byte[] requestHash, uint fault) =>
        new Meta()
            .Byte(Tag.SignatureType, SignatureType.AesGcmResponse)
            .Byte(Tag.Domain, (byte)domain)
            .Field(Tag.Personalization, _vinBytes)
            .Uint32(Tag.Counter, counter)
            .Uint32(Tag.Flags, flags)
            .Field(Tag.RequestHash, requestHash)
            .Uint32(Tag.Fault, fault)
            .Checksum();

    /// Identifies which request a response belongs to: the signature type byte
    /// followed by the request's authentication tag, truncated to 16 bytes.
    private static byte[] RequestHash(byte[] tag)
    {
        var hash = new byte[17];
        hash[0] = SignatureType.AesGcmPersonalized;
        tag.AsSpan(0, Math.Min(16, tag.Length)).CopyTo(hash.AsSpan(1));
        return hash;
    }

    // --- console-driven controls ---

    private void Changed()
    {
        StateChanged?.Invoke();
        if (BroadcastStatusChanges) Emit(BuildStatusPayload(), "an unsolicited VehicleStatus broadcast");
    }

    /// Models the owner tapping their keycard on the centre console.
    public bool TapKeycard()
    {
        lock (_gate) return TapKeycardLocked();
    }

    private bool TapKeycardLocked()
    {
        if (_pendingEnrolment?.PublicKey is null) return false;

        var id = Convert.ToHexString(_pendingEnrolment.PublicKey).ToLowerInvariant();
        _whitelist[id] = new EnrolledKey(_pendingEnrolment.Role, _pendingEnrolment.FormFactor, DateTime.UtcNow);
        _pendingEnrolment = null;

        Log?.Invoke("enrol", $"keycard tapped — key {id[..16]}… is now enrolled");
        Emit(Messages.BuildCommandStatus(OperationStatus.Ok), "the enrolment approval");
        StateChanged?.Invoke();
        return true;
    }

    /// Rotates the epoch the way a real module does at boot, voiding every
    /// session established before it.
    public void Reboot()
    {
        lock (_gate)
        {
            _epoch = RandomNumberGenerator.GetBytes(16);
            _domains.Clear();
            _awake = false;
            Log?.Invoke("car", "rebooted; epoch rotated and every session voided");
            StateChanged?.Invoke();
        }
    }

    public void ForgetKeys()
    {
        lock (_gate)
        {
            var count = _whitelist.Count;
            _whitelist.Clear();
            _pendingEnrolment = null;
            Log?.Invoke("car", $"whitelist cleared ({count} key{(count == 1 ? "" : "s")} forgotten)");
            StateChanged?.Invoke();
        }
    }

    public void FailNextCounter()
    {
        lock (_gate)
        {
            _injectCounterFault = true;
            Log?.Invoke("car", "the next command will be rejected as a repeated counter");
        }
    }

    /// Leaves a door standing open, which is what makes a car refuse to lock.
    public bool ToggleDoorAjar()
    {
        lock (_gate)
        {
            var open = _closures[ClosureField.FrontDriverDoor] != ClosureState.Closed;
            SetClosure(ClosureField.FrontDriverDoor, open ? ClosureState.Closed : ClosureState.Open);
            Log?.Invoke("car", open ? "front driver door shut" : "front driver door left open");
            Changed();
            return !open;
        }
    }

    public void ShutEverything()
    {
        lock (_gate)
        {
            foreach (var field in _closures.Keys.ToList())
            {
                CancelMotion(field);
                SetClosure(field, ClosureState.Closed);
            }
            Log?.Invoke("car", "every closure shut");
            Changed();
        }
    }

    public void BroadcastStatus()
    {
        lock (_gate)
        {
            Log?.Invoke("tx", "broadcasting an unsolicited VehicleStatus");
            Emit(BuildStatusPayload(), "a VehicleStatus broadcast");
        }
    }

    public IReadOnlyList<string> DescribeKeys()
    {
        lock (_gate)
        {
            return _whitelist
                .Select(pair => $"{pair.Key[..16]}…  {Role.Name(pair.Value.Role)}, " +
                                $"{KeyFormFactor.Name(pair.Value.FormFactor)}, added {pair.Value.AddedUtc:yyyy-MM-dd HH:mm} UTC")
                .ToList();
        }
    }

    public VehicleSnapshot Snapshot()
    {
        lock (_gate)
        {
            return new VehicleSnapshot(
                Vin,
                LocalName,
                _lockState,
                new Dictionary<int, int>(_closures),
                _awake,
                _whitelist.Count,
                _pendingEnrolment is not null,
                Convert.ToHexString(_epoch)[..8].ToLowerInvariant(),
                Clock,
                DomainFor(Domain.VehicleSecurity).Counter);
        }
    }

    public VehicleStore.State Persist()
    {
        lock (_gate)
        {
            return new VehicleStore.State
            {
                Vin = Vin,
                PrivateKey = Convert.ToBase64String(_key.ExportECPrivateKey()),
                Epoch = Convert.ToHexString(_epoch),
                Clock = Clock,
                LockState = _lockState,
                Keys = _whitelist.Select(pair => new VehicleStore.KeyEntry
                {
                    PublicKey = pair.Key,
                    Role = pair.Value.Role,
                    FormFactor = pair.Value.FormFactor,
                    AddedUtc = pair.Value.AddedUtc
                }).ToList(),
                Counters = _domains.ToDictionary(pair => pair.Key.ToString(), pair => pair.Value.Counter)
            };
        }
    }
}
