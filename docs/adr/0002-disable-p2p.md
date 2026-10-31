# Disable peer-to-peer mode

Jitsi normally sends a two-person call peer-to-peer, bypassing the videobridge. We disable P2P for the whole deployment so every consultation's media always passes through JVB, where the recorder bot can receive it; otherwise a patient and one staff member would fall back to P2P whenever the bot is absent or reconnecting, and that part of the consultation would go unrecorded. The cost is extra bridge bandwidth and slightly higher latency for 1:1 calls.
