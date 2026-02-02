# Distinctly Developed Auth

**Updated:** 2026-01-31

## Login Credentials
- **Username:** robert
- **Password:** MissionControl2026!

## API Access (for cron jobs)
JWT Secret: `78c6b5cef895adc0be8cdcfd075975776d785f23f080bff88a2defc9b0a87eaf`

To get a token:
```bash
curl -X POST "https://distinctlydeveloped.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"robert","password":"MissionControl2026!"}'
```

Use in header: `Authorization: Bearer <token>`
