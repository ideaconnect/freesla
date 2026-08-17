// The car's account of what happened, for when the key cannot give one.
//
// A Zepp watch that trips its watchdog does not report anything: it reboots.
// Whatever it was doing at the time is lost, and the only record of it is what
// this program saw arrive and what it had just sent. So the trace has to be
// good enough to answer, after the fact, "what was the key in the middle of?"
//
// Three things make that possible, and none of them is more logging for its own
// sake:
//
//   Deltas. Every line carries how long it has been since the previous one. A
//   watch that stalls does not announce it -- it simply stops, and the gap is
//   the only evidence. The gap is therefore printed rather than left to be
//   worked out from wall-clock timestamps.
//
//   Intent before action. A line goes out *before* each fragment is written,
//   not after, so a burst that dies halfway names the fragment it died on. Log
//   after the fact and the last thing you see is the last thing that *worked*,
//   which is the one thing you already knew.
//
//   Silence. Nothing arriving is the signal here, and an event-driven log is
//   silent about silence. So a timer says so out loud, and repeats, naming the
//   last thing this program sent.

using System.Diagnostics;

namespace TeslaMock;

public enum Verbosity
{
    /// Commands and car state only.
    Quiet = 0,

    /// The default: protocol milestones, as before.
    Normal = 1,

    /// Every GATT operation, with sizes, deltas and one line per fragment.
    Verbose = 2,

    /// The above with the bytes.
    Trace = 3
}

public static class Trace
{
    private static readonly Stopwatch Since = Stopwatch.StartNew();
    private static readonly object Gate = new();
    private static TimeSpan _previous = TimeSpan.Zero;

    public static Verbosity Level = Verbosity.Normal;

    public static bool Enabled(Verbosity level) => Level >= level;

    /// Seconds since this program started, and since the previous traced line.
    ///
    /// Both, because they answer different questions: the absolute figure lines
    /// a trace up against a video of a watch face, and the delta is where a
    /// stall shows up without anybody doing arithmetic.
    public static string Stamp()
    {
        lock (Gate)
        {
            var now = Since.Elapsed;
            var delta = now - _previous;
            _previous = now;
            return $"{now.TotalSeconds,8:F3} +{delta.TotalSeconds,6:F3}";
        }
    }

    /// How long since the last traced line, without claiming one.
    public static TimeSpan Quiet()
    {
        lock (Gate) return Since.Elapsed - _previous;
    }

    public static TimeSpan Now => Since.Elapsed;

    // The two facts the silence reporter needs, and the only mutable state
    // here. Kept in one place rather than threaded through the link interface
    // because every layer that learns one of them -- the GATT server, the
    // socket, the vehicle -- would otherwise have to hand it up through code
    // that has no other reason to care. One car per process makes that safe.
    private static TimeSpan _lastHeard = TimeSpan.Zero;
    private static string? _lastSent;
    private static TimeSpan _lastSentAt = TimeSpan.Zero;

    /// The key said something.
    ///
    /// Subscribing counts, and counts as much as a protocol message: writing
    /// the descriptor that enables notifications is the last thing a key does
    /// before it starts thinking, so it is the mark the silence after it is
    /// measured from. Without it, a key that dies during its own connection
    /// setup would be reported as silent for as long as this program had been
    /// running.
    public static void Heard()
    {
        lock (Gate) _lastHeard = Since.Elapsed;
    }

    /// The car is about to say something. Recorded before it goes out, so a
    /// burst that never finishes is still attributed to the right message.
    public static void Sending(string what)
    {
        lock (Gate)
        {
            _lastSent = what;
            _lastSentAt = Since.Elapsed;
        }
    }

    /// How long the key has been silent, and what it was given last.
    ///
    /// The "nothing yet" case is the one worth wording carefully rather than
    /// leaving to a null. A key that subscribes and then never speaks has not
    /// been defeated by anything the car sent it -- it went down setting its
    /// own connection up, which is a different fault in a different file, and
    /// a trace that blamed the last reply would send somebody to the wrong one.
    public static (TimeSpan silentFor, string lastSent, TimeSpan sentAgo) Silence()
    {
        lock (Gate)
        {
            var now = Since.Elapsed;
            return (
                now - _lastHeard,
                _lastSent ?? "nothing at all — the key has not been sent anything since it subscribed",
                now - _lastSentAt);
        }
    }

    /// True while the car has yet to send this key anything.
    public static bool NothingSentYet
    {
        get { lock (Gate) return _lastSent is null; }
    }

    /// How a key left, in one sentence, for whichever link noticed.
    ///
    /// Read under a single lock rather than assembled from the properties
    /// above: the two halves of this sentence have to describe the same
    /// moment, and a key disconnecting is exactly when another thread is
    /// likely to be writing one of them.
    public static string Epitaph(string verb)
    {
        lock (Gate)
        {
            var now = Since.Elapsed;
            var silentFor = (now - _lastHeard).TotalSeconds;
            if (_lastSent is null)
            {
                return $"the key {verb} after {silentFor:F3}s of silence, without ever being sent " +
                       "anything — it did not get as far as saying hello";
            }
            return $"the key {verb} after {silentFor:F3}s of silence; the last thing sent was " +
                   $"{_lastSent} ({(now - _lastSentAt).TotalSeconds:F3}s ago)";
        }
    }

    /// A short, aligned hex rendering. Long fragments are cut: the interesting
    /// part of a stalled exchange is which fragment, not its two hundredth byte.
    public static string Hex(ReadOnlySpan<byte> bytes, int limit = 24)
    {
        var take = Math.Min(limit, bytes.Length);
        var text = Convert.ToHexString(bytes[..take]).ToLowerInvariant();
        var spaced = new System.Text.StringBuilder(text.Length + take / 2);
        for (var i = 0; i < text.Length; i += 2)
        {
            if (i > 0) spaced.Append(' ');
            spaced.Append(text[i]).Append(text[i + 1]);
        }
        if (take < bytes.Length) spaced.Append($" … ({bytes.Length} bytes)");
        return spaced.ToString();
    }
}
