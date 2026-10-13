Loop's active knowledge source is past-user-issues.csv.

Columns: rank, description_of_issue, number_of_users.
Rank 1 identifies the most common concern. These six rows are synthetic demo
data requested for the demo, not measurements from the recorded studies.

The hosted application exposes only this demo CSV at
/knowledge-base/past-user-issues.csv so Tavus can import it. Study transcripts,
clips, and reports remain authenticated. Do not put private research in this
public demo source; private research needs an expiring download URL instead.

server/tavus.ts uploads the CSV through Tavus's Documents API, saves the document
ID and source/account hashes in data/tavus-knowledge.json, and checks readiness.
New conversations attach that document_id using Tavus default retrieval (quality).
A changed CSV or API key creates a new document; start interviews after Tavus
finishes processing. Unchanged sources reuse the existing document.

Mira retrieves rank 1 after the overall-experience answer. Loop no longer selects
or injects the top issue. Objectives still track the shopper's answer or decline.
The old sample-issues.json and knowledge-base.ts support historical fixtures only.
