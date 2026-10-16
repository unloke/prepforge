# Hark judging run (operator: Codex)

You only operate the browser. Hark is the judge: never write or edit a label yourself.

1. In the Brave browser, open https://hark.com (already signed in). Create a NEW Hark project named
   "Reason taste judge" so Hark sees no earlier chat (not "Research Design Improvement", not "Chess
   Reason Blind Review"). Default model.
2. For NN = 01 .. 12: paste the whole file `msg-NN.txt` (this folder) as one message, send, and wait
   until Hark's reply is complete (it can take several minutes; check every 30-60 s).
3. Save Hark's reply exactly as shown into `raw/batch-NN.txt`, and the JSON lines from its code
   block into `out/batch-NN.jsonl`. Check: one line per card, the `n` values equal the cards in
   msg-NN.txt in order, each line has as many candidates as that card. If the reply is cut off,
   ask Hark to continue from the last n and append its lines. If a line is malformed, ask Hark to
   resend that card; do not fix labels by hand.
4. Write files with Node/Python (UTF-8), not through a PowerShell command line.
5. Do not tell Hark about other judges, the user's picks or expected answers. Do not send anything
   else from this computer.
6. If Hark asks to sign in, a permission or CAPTCHA appears, or Brave cannot be controlled, stop and
   report. Do not work around it.

When all 12 batches are saved and checked, report the counts.
