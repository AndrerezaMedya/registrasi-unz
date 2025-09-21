## Admin Roles

We extended the `admins` table with a nullable `role` column.

Roles used:

- `staff` : Regular gate operator (default if null)
- `super` : Super administrator (full access / future elevated UI features)

JWT payload now includes:

```
{
  admin_id: "gate1",
  role: "staff", // or "super"
  exp: <unix timestamp>
}
```

Login response shape:

```
{ ok:true, admin_id:"gate1", role:"staff", token:"<JWT>" }
```

To add role column manually (already applied if you ran migration SQL):

```
ALTER TABLE admins ADD COLUMN role TEXT;
```

Super admin account suggested: `regis@admin.com` with role `super`.
