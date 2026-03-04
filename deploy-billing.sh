#!/bin/bash
# StyleMCP Full Billing Deployment
# Run this on your VPS after setting up Supabase and Stripe

set -e

echo "Deploying StyleMCP with Billing..."

# Check for required env vars
if [ -z "$SUPABASE_URL" ] || [ -z "$STRIPE_SECRET_KEY" ]; then
  echo ""
  echo "ERROR: Missing environment variables!"
  echo ""
  echo "Please set the following in /opt/stylemcp/.env:"
  echo "  SUPABASE_URL=https://db-stylemcp.distinctlydeveloped.com"
  echo "  SUPABASE_SERVICE_KEY=eyJhbGc..."
  echo "  STRIPE_SECRET_KEY=sk_..."
  echo "  STRIPE_WEBHOOK_SECRET=whsec_..."
  echo ""
  echo "Then run this script again."
  exit 1
fi

# Create landing pages directory
mkdir -p /var/www/stylemcp

# Copy all landing pages
for file in /opt/stylemcp/landing/*.html; do
  cp "$file" /var/www/stylemcp/
done

# Update nginx config
cat > /etc/nginx/sites-available/stylemcp.com << 'NGINXEOF'
server {
    listen 80;
    listen [::]:80;
    server_name stylemcp.com www.stylemcp.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name stylemcp.com www.stylemcp.com;

    ssl_certificate /etc/letsencrypt/live/stylemcp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stylemcp.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /var/www/stylemcp;
    index index.html;

    # Static pages
    location / {
        try_files $uri $uri/ $uri.html /index.html;
    }

    # API endpoints
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SSE endpoint (long timeout)
    location /api/mcp/sse {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        chunked_transfer_encoding off;
    }

    # Stripe webhook (raw body needed)
    location /api/webhook/stripe {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check
    location /health {
        proxy_pass http://127.0.0.1:3000;
    }
}
NGINXEOF

# Test and reload nginx
nginx -t && systemctl reload nginx

# Rebuild Docker container
cd /opt/stylemcp
docker compose down
docker compose up -d --build

echo ""
echo "Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Run the database migration in Supabase SQL Editor"
echo "   (copy contents of supabase/migrations/001_create_tables.sql)"
echo ""
echo "2. Update Supabase credentials in landing pages:"
echo "   /var/www/stylemcp/login.html"
echo "   /var/www/stylemcp/signup.html"
echo "   /var/www/stylemcp/dashboard.html"
echo ""
echo "3. Test at https://stylemcp.com/signup.html"
