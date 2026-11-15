---------------------------- MODULE VersionHistory ----------------------------
EXTENDS Naturals, Sequences

CONSTANTS Writers, Entities, Bodies, MaxEntries, None

VARIABLES history, projection, lock, snapshot, pc, intent, head, receipts

vars == <<history, projection, lock, snapshot, pc, intent, head, receipts>>

HistoryIsProtected == TRUE

Genesis == << >>

Hash(prev, content) == <<prev, content>>

Content(row) == [seq |-> row.seq, entity |-> row.entity, body |-> row.body]

HeadOf(h) ==
  IF h = << >>
    THEN [seq |-> 0, hash |-> Genesis]
    ELSE [seq |-> h[Len(h)].seq, hash |-> h[Len(h)].hash]

RowFor(w) ==
  LET content == [seq |-> head[w].seq + 1, entity |-> intent[w].entity, body |-> intent[w].body]
  IN [seq |-> content.seq, entity |-> content.entity, body |-> content.body,
      prev |-> head[w].hash, hash |-> Hash(head[w].hash, content)]

Without(h, i) == [j \in 1..(Len(h) - 1) |-> IF j < i THEN h[j] ELSE h[j + 1]]

Committed ==
  IF lock = None
    THEN [history |-> history, projection |-> projection]
    ELSE snapshot

LastBody(h, e) ==
  IF \E i \in 1..Len(h) : h[i].entity = e
    THEN h[CHOOSE i \in 1..Len(h) : h[i].entity = e /\ \A j \in (i + 1)..Len(h) : h[j].entity # e].body
    ELSE None

Init ==
  /\ history = << >>
  /\ projection = [e \in Entities |-> None]
  /\ lock = None
  /\ snapshot = [history |-> << >>, projection |-> [e \in Entities |-> None]]
  /\ pc = [w \in Writers |-> "idle"]
  /\ intent = [w \in Writers |-> None]
  /\ head = [w \in Writers |-> HeadOf(<< >>)]
  /\ receipts = {}

Receive(w, e, b) ==
  /\ pc[w] = "idle"
  /\ intent' = [intent EXCEPT ![w] = [entity |-> e, body |-> b]]
  /\ head' = head
  /\ pc' = [pc EXCEPT ![w] = "to_begin"]
  /\ UNCHANGED <<history, projection, lock, snapshot, receipts>>

Begin(w) ==
  /\ pc[w] = "to_begin"
  /\ lock = None
  /\ lock' = w
  /\ snapshot' = [history |-> history, projection |-> projection]
  /\ head' = [head EXCEPT ![w] = HeadOf(Committed.history)]
  /\ pc' = [pc EXCEPT ![w] = "to_append"]
  /\ UNCHANGED <<history, projection, intent, receipts>>

AppendHistory(w) ==
  /\ pc[w] = "to_append"
  /\ Len(history) < MaxEntries
  /\ history' = Append(history, RowFor(w))
  /\ pc' = [pc EXCEPT ![w] = "to_project"]
  /\ UNCHANGED <<projection, lock, snapshot, intent, head, receipts>>

UpdateProjection(w) ==
  /\ pc[w] = "to_project"
  /\ projection' = [projection EXCEPT ![intent[w].entity] = intent[w].body]
  /\ pc' = [pc EXCEPT ![w] = "to_commit"]
  /\ UNCHANGED <<history, lock, snapshot, intent, head, receipts>>

Commit(w) ==
  /\ pc[w] = "to_commit"
  /\ lock = w
  /\ lock' = None
  /\ receipts' = receipts \cup {[seq |-> RowFor(w).seq, hash |-> RowFor(w).hash]}
  /\ pc' = [pc EXCEPT ![w] = "to_reply"]
  /\ UNCHANGED <<history, projection, snapshot, intent, head>>

Forget(w) ==
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ intent' = [intent EXCEPT ![w] = None]
  /\ head' = [head EXCEPT ![w] = HeadOf(<< >>)]

Reply(w) ==
  /\ pc[w] = "to_reply"
  /\ Forget(w)
  /\ UNCHANGED <<history, projection, lock, snapshot, receipts>>

Rollback(w) ==
  /\ lock = w
  /\ history' = snapshot.history
  /\ projection' = snapshot.projection
  /\ lock' = None
  /\ Forget(w)
  /\ UNCHANGED <<snapshot, receipts>>

DeleteHistoryRow(i) ==
  /\ ~HistoryIsProtected
  /\ lock = None
  /\ i \in 1..Len(history)
  /\ history' = Without(history, i)
  /\ UNCHANGED <<projection, lock, snapshot, pc, intent, head, receipts>>

Next ==
  \/ \E w \in Writers, e \in Entities, b \in Bodies : Receive(w, e, b)
  \/ \E w \in Writers : Begin(w) \/ AppendHistory(w) \/ UpdateProjection(w) \/ Commit(w) \/ Reply(w) \/ Rollback(w)
  \/ \E i \in 1..MaxEntries : DeleteHistoryRow(i)

Spec == Init /\ [][Next]_vars

RowsOK(h) ==
  /\ Len(h) <= MaxEntries
  /\ \A i \in 1..Len(h) : h[i].seq \in 1..MaxEntries /\ h[i].entity \in Entities /\ h[i].body \in Bodies

TypeOK ==
  /\ RowsOK(history)
  /\ RowsOK(snapshot.history)
  /\ projection \in [Entities -> Bodies \cup {None}]
  /\ snapshot.projection \in [Entities -> Bodies \cup {None}]
  /\ lock \in Writers \cup {None}
  /\ pc \in [Writers -> {"idle", "to_begin", "to_append", "to_project", "to_commit", "to_reply"}]
  /\ \A w \in Writers : (pc[w] = "idle") = (intent[w] = None)
  /\ \A w \in Writers : (pc[w] \in {"to_append", "to_project", "to_commit"}) = (lock = w)
  /\ \A w \in Writers : head[w].seq \in 0..MaxEntries
  /\ \A r \in receipts : r.seq \in 1..MaxEntries

HistoryOnlyGrows ==
  \A r \in receipts :
    /\ r.seq <= Len(Committed.history)
    /\ Committed.history[r.seq].hash = r.hash

ProjectionMatchesLastEntry ==
  \A e \in Entities : Committed.projection[e] = LastBody(Committed.history, e)

ChainVerifies ==
  LET h == Committed.history IN
  \A i \in 1..Len(h) :
    /\ h[i].seq = i
    /\ h[i].prev = (IF i = 1 THEN Genesis ELSE h[i - 1].hash)
    /\ h[i].hash = Hash(h[i].prev, Content(h[i]))

===============================================================================
