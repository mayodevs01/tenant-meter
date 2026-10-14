# Security

If you find a security issue, please use GitHub's private vulnerability reporting for this repository once it is published. If that feature is unavailable, open an issue asking for a private contact channel without disclosing exploit details.

Tenant Meter stores potentially sensitive usage metadata in the SQLite file. Protect the file with your application's access controls and backups. The library does not authenticate callers; a host application must supply a tenant ID derived from its own trusted authorization context.
