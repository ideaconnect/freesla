// The half of the link the car owns.
//
// Whole protocol messages in and out; framing and fragmentation belong to the
// implementation, because that is the part that differs between a GATT
// characteristic and a socket.

namespace TeslaMock.Transport;

public interface ILink : IAsyncDisposable
{
    /// A complete, reassembled protocol message from the key.
    event Action<byte[]>? Message;

    /// Human-readable transport milestones for the console.
    event Action<string>? Note;

    /// True once something is connected and subscribed to notifications.
    bool IsConnected { get; }

    Task StartAsync(CancellationToken token);

    /// Fragments and sends one protocol message.
    void Send(byte[] message);
}
