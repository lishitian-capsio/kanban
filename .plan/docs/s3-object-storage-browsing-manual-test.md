# Manual test: S3 storage browsing against MinIO

1. Run MinIO: `docker run -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address ":9001"`
2. In the MinIO console (http://localhost:9001, creds minioadmin/minioadmin) create a bucket `assets` and upload: a text file, an image, and a >1 MB text file.
3. In Kanban, open the Storage surface (top-bar "Storage" button) → Add connection:
   - endpoint `http://localhost:9000`, region `us-east-1`, bucket `assets`, virtualHostedStyle OFF (path-style), accessKeyId/secretAccessKey `minioadmin`.
4. Save, then Test connection → expect ok + latency.
5. Browse: folders (commonPrefixes) render; double-click descends; breadcrumb ascends; "Load more" appears past 1000 keys.
6. Preview: text renders in the read-only CodeMirror; image renders inline; the >1 MB text file shows "too large → download"; download works.
7. Confirm READ-ONLY: there is NO create/rename/delete/upload affordance for objects anywhere in the surface.
