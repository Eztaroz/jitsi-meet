# Disable breakout rooms; move participants only from the central coordinator

Jitsi's breakout rooms let a moderator move participants, but only between sub-rooms of one conference, and every move is decided inside that conference. The hospital wants one coordinator to place any participant, patients included, in any room. We disable breakout rooms fully (the Prosody `muc_breakout_rooms` module and every button for them) so that the only way anyone changes rooms is a move issued centrally, which also keeps each consultation's evidence in one room per patient.

## Considered Options

- Keep breakout rooms alongside central moves: rejected, because a moderator could then split a patient's room into sub-rooms the coordinator does not see and the recorder bot does not record.
