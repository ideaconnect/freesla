// The car on a socket.
//
// No Bluetooth involved, and that is the point: it makes the protocol testable
// on any machine, in CI, and from a script, with the same framing and the same
// 20-byte fragmentation a GATT link imposes. Everything above this line cannot
// tell the difference.

using System.Net;
using System.Net.Sockets;
using TeslaMock.Protocol;

namespace TeslaMock.Transport;

public sealed class TcpLink : ILink
{
    private readonly int _port;
    private readonly int _chunkSize;
    private readonly object _gate = new();

    private TcpListener? _listener;
    private NetworkStream? _stream;
    private Task? _accepting;
    private CancellationTokenSource? _cancellation;

    public TcpLink(int port, int chunkSize)
    {
        _port = port;
        _chunkSize = chunkSize;
    }

    public event Action<byte[]>? Message;
    public event Action<string>? Note;

    public bool IsConnected
    {
        get { lock (_gate) return _stream is not null; }
    }

    public int Port => ((IPEndPoint)_listener!.LocalEndpoint).Port;

    public Task StartAsync(CancellationToken token)
    {
        _cancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
        _listener = new TcpListener(IPAddress.Loopback, _port);
        _listener.Start();

        // Printed in a shape a script can wait for.
        Note?.Invoke($"listening on 127.0.0.1:{Port}");
        _accepting = Task.Run(() => AcceptLoop(_cancellation.Token));
        return Task.CompletedTask;
    }

    private async Task AcceptLoop(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener!.AcceptTcpClientAsync(token);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception e)
            {
                Note?.Invoke("accept failed: " + e.Message);
                return;
            }

            client.NoDelay = true;
            var stream = client.GetStream();
            lock (_gate) _stream = stream;
            Trace.Heard();
            Note?.Invoke("a key connected");

            var reassembler = new Reassembler();
            var buffer = new byte[512];

            try
            {
                while (!token.IsCancellationRequested)
                {
                    var read = await stream.ReadAsync(buffer, token);
                    if (read <= 0) break;

                    List<byte[]> messages;
                    try
                    {
                        messages = reassembler.Push(buffer.AsSpan(0, read));
                    }
                    catch (FormatException e)
                    {
                        Note?.Invoke("framing error: " + e.Message);
                        reassembler.Reset();
                        continue;
                    }
                    foreach (var message in messages) Message?.Invoke(message);
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception e)
            {
                Note?.Invoke("read failed: " + e.Message);
            }
            finally
            {
                lock (_gate) _stream = null;
                client.Dispose();

                // The same epitaph the GATT link writes, and for the same
                // reason: a link that goes away is the only notice a crashed
                // key ever gives, and "disconnected" on its own does not say
                // what it was in the middle of.
                Note?.Invoke(Trace.Enabled(Verbosity.Verbose)
                    ? Trace.Epitaph("disconnected")
                    : "the key disconnected");
            }
        }
    }

    public void Send(byte[] message)
    {
        NetworkStream? stream;
        lock (_gate) stream = _stream;
        if (stream is null)
        {
            Note?.Invoke("nothing connected; reply dropped");
            return;
        }

        try
        {
            foreach (var chunk in Framing.Frame(message, _chunkSize)) stream.Write(chunk, 0, chunk.Length);
        }
        catch (Exception e)
        {
            Note?.Invoke("write failed: " + e.Message);
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cancellation?.Cancel();
        try
        {
            _listener?.Stop();
        }
        catch (Exception)
        {
            // Shutting down; a listener that is already gone is not a problem.
        }
        if (_accepting is not null)
        {
            try
            {
                await _accepting;
            }
            catch (Exception)
            {
            }
        }
        _cancellation?.Dispose();
    }
}
