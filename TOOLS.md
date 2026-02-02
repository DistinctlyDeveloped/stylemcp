# TOOLS.md - Local Notes

## SSH Access

### StyleMCP VPS
- **Host:** 82.180.163.60
- **User:** root
- **Command:** `ssh root@82.180.163.60`
- **Repo path:** `/opt/stylemcp/`
- **Web root:** `/var/www/stylemcp/`

**Deploy website:**
```bash
ssh root@82.180.163.60 "cd /opt/stylemcp && git pull && cp landing/*.html /var/www/stylemcp/"
```

**Deploy API:**
```bash
ssh root@82.180.163.60 "cd /opt/stylemcp && git pull && docker compose up -d --build"
```
