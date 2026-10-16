# Second judge (Hark) for the 360 development cards

Open a new Hark project at https://hark.com (any default model; it must not see the earlier
"Research Design Improvement" chat). For each `msg-NN.txt` (01..12, 30 cards each), paste the whole
file as one message, wait for the full reply, and save the JSON lines from its code block to
`out/batch-NN.jsonl` (one line per card, n in order). If a reply is cut off, ask Hark to continue
from the last n and append. Do not edit the cards or tell Hark about other labels.
