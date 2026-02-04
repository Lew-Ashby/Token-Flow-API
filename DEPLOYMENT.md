# 🚀 Token Flow API - Deployment Guide

## 📋 Pre-Deployment Checklist

Before deploying to production, complete ALL items in this checklist:

### 🔐 Security (CRITICAL)

- [ ] **Rotate Helius API Key** - Get new key from [helius.xyz](https://helius.xyz)
  - Never commit API keys to version control
  - Store in .env file which is gitignored
- [ ] **Generate Secure Database Password**
  ```bash
  openssl rand -base64 32
  ```
- [ ] **Generate Secure Admin API Key**
  ```bash
  openssl rand -hex 32
  ```
- [ ] **Generate Secure API Key Salt**
  ```bash
  openssl rand -hex 32
  ```
- [ ] **Update .env with all generated values**
- [ ] **Set `NODE_ENV=production` in .env**
- [ ] **Configure `ALLOWED_ORIGINS` for your domain**
- [ ] **Verify .env is in .gitignore**
- [ ] **Run security validation**
  ```bash
  ./scripts/validate-security.sh
  ```

### 🧪 Testing

- [ ] **Run security tests**
  ```bash
  ./scripts/test-security-fixes.sh
  ```
- [ ] **Test all API endpoints**
- [ ] **Verify ML service connectivity**
- [ ] **Test rate limiting**
- [ ] **Test CORS configuration**

### 📊 Monitoring & Logging

- [ ] Set up error tracking (Sentry, Rollbar, etc.)
- [ ] Configure log aggregation (CloudWatch, Datadog, etc.)
- [ ] Set up uptime monitoring
- [ ] Configure alerts for API errors
- [ ] Set up Helius API usage monitoring

### 🗄️ Database

- [ ] Backup existing data (if any)
- [ ] Run database migrations
- [ ] Verify database connectivity
- [ ] Set up automated backups
- [ ] Configure connection pooling

---

## 🏗️ Deployment Options

### Option 1: Docker Compose (Recommended for Single Server)

#### Step 1: Prepare Environment

```bash
# Clone repository
git clone <your-repo-url>
cd token-flow-api

# Copy and configure environment
cp .env.example .env
nano .env  # Edit with your values

# Validate security
./scripts/validate-security.sh
```

#### Step 2: Build and Start Services

```bash
# Build all services
docker-compose build

# Start services in detached mode
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

#### Step 3: Verify Deployment

```bash
# Test API health
curl https://your-domain.com/health

# Test ML service
curl -X GET https://your-domain.com/api/v1/ml/health \
  -H "x-admin-key: YOUR_ADMIN_KEY"

# Run full security tests
./scripts/test-security-fixes.sh
```

#### Step 4: Monitor Services

```bash
# View logs
docker-compose logs -f api
docker-compose logs -f ml-inference

# Check resource usage
docker stats

# Restart services if needed
docker-compose restart
```

---

### Option 2: Kubernetes (Recommended for Production Scale)

#### Prerequisites

- Kubernetes cluster (AWS EKS, GKE, AKS, or self-hosted)
- kubectl configured
- Helm 3+ installed

#### Step 1: Create Kubernetes Secrets

```bash
# Create namespace
kubectl create namespace token-flow-api

# Create secrets from .env
kubectl create secret generic token-flow-api-secrets \
  --from-env-file=.env \
  --namespace=token-flow-api

# Verify secrets
kubectl get secrets -n token-flow-api
```

#### Step 2: Deploy with Helm (if available)

```bash
# Install chart
helm install token-flow-api ./k8s/helm \
  --namespace token-flow-api \
  --values ./k8s/helm/values-production.yaml

# Check deployment
kubectl get pods -n token-flow-api
kubectl get services -n token-flow-api
```

#### Step 3: Configure Ingress

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: token-flow-api
  namespace: token-flow-api
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  tls:
  - hosts:
    - api.yourdomain.com
    secretName: token-flow-api-tls
  rules:
  - host: api.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: token-flow-api
            port:
              number: 3000
```

Apply ingress:
```bash
kubectl apply -f k8s/ingress.yaml
```

---

### Option 3: Cloud Platform (AWS/GCP/Azure)

#### AWS Elastic Beanstalk

```bash
# Install EB CLI
pip install awsebcli

# Initialize EB application
eb init -p docker token-flow-api

# Create environment
eb create production-env \
  --instance-type t3.medium \
  --envvars NODE_ENV=production,HELIUS_API_KEY=your_key

# Deploy
eb deploy
```

#### Google Cloud Run

```bash
# Build and push image
gcloud builds submit --tag gcr.io/YOUR_PROJECT/token-flow-api

# Deploy
gcloud run deploy token-flow-api \
  --image gcr.io/YOUR_PROJECT/token-flow-api \
  --platform managed \
  --region us-central1 \
  --set-env-vars NODE_ENV=production \
  --set-secrets HELIUS_API_KEY=helius-key:latest
```

#### Azure Container Instances

```bash
# Create resource group
az group create --name token-flow-api --location eastus

# Deploy
az container create \
  --resource-group token-flow-api \
  --name token-flow-api \
  --image your-registry/token-flow-api:latest \
  --environment-variables NODE_ENV=production \
  --secure-environment-variables HELIUS_API_KEY=your_key
```

---

## 🔒 Secrets Management (Production Best Practice)

### AWS Secrets Manager

```bash
# Store Helius key
aws secretsmanager create-secret \
  --name token-flow-api/helius-key \
  --secret-string "your_helius_api_key"

# Store admin key
aws secretsmanager create-secret \
  --name token-flow-api/admin-key \
  --secret-string "your_admin_api_key"

# Update application to fetch secrets
# See: services/api/src/config/secrets.ts
```

### HashiCorp Vault

```bash
# Enable KV secrets engine
vault secrets enable -path=token-flow-api kv-v2

# Store secrets
vault kv put token-flow-api/config \
  helius_api_key="your_key" \
  admin_api_key="your_admin_key"

# Grant access to application
vault policy write token-flow-api-policy - <<EOF
path "token-flow-api/*" {
  capabilities = ["read"]
}
EOF
```

### Google Secret Manager

```bash
# Store secrets
echo -n "your_helius_key" | gcloud secrets create helius-api-key --data-file=-
echo -n "your_admin_key" | gcloud secrets create admin-api-key --data-file=-

# Grant access
gcloud secrets add-iam-policy-binding helius-api-key \
  --member="serviceAccount:token-flow-api@project.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 🌐 Domain & SSL Configuration

### Using Let's Encrypt (Free SSL)

```bash
# Install certbot
sudo apt-get install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d api.yourdomain.com

# Auto-renewal (runs twice daily)
sudo systemctl enable certbot.timer
```

### Using AWS Certificate Manager

```bash
# Request certificate
aws acm request-certificate \
  --domain-name api.yourdomain.com \
  --validation-method DNS

# Follow DNS validation instructions
# Then attach certificate to load balancer
```

---

## 📊 Monitoring & Observability

### Application Performance Monitoring

#### Datadog

```javascript
// services/api/src/index.ts
import tracer from 'dd-trace';
tracer.init({
  service: 'token-flow-api',
  env: process.env.NODE_ENV,
  version: '1.0.0',
});
```

#### New Relic

```javascript
require('newrelic');
// Rest of your application code
```

### Log Aggregation

#### CloudWatch (AWS)

```bash
# Install CloudWatch agent
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
sudo rpm -U ./amazon-cloudwatch-agent.rpm

# Configure log streaming
aws logs create-log-group --log-group-name /token-flow-api
```

#### Elasticsearch + Kibana

```yaml
# docker-compose.yml
services:
  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
    ports:
      - "9200:9200"

  kibana:
    image: kibana:8.11.0
    ports:
      - "5601:5601"
    depends_on:
      - elasticsearch
```

---

## 🔄 CI/CD Pipeline

### GitHub Actions Example

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run Security Validation
        run: |
          cp .env.production .env
          ./scripts/validate-security.sh

      - name: Run Tests
        run: |
          docker-compose up -d
          sleep 10
          ./scripts/test-security-fixes.sh

      - name: Build and Push Docker Image
        run: |
          docker build -t token-flow-api:${{ github.sha }} .
          docker push your-registry/token-flow-api:${{ github.sha }}

      - name: Deploy to Production
        run: |
          kubectl set image deployment/token-flow-api \
            api=your-registry/token-flow-api:${{ github.sha }}
```

---

## 🚨 Troubleshooting

### Services Won't Start

```bash
# Check logs
docker-compose logs -f

# Check environment variables
docker-compose exec api env | grep -E "HELIUS|ADMIN|NODE_ENV"

# Restart services
docker-compose down
docker-compose up -d
```

### Database Connection Issues

```bash
# Check database is running
docker-compose ps postgres

# Test connection
docker-compose exec postgres psql -U token_flow_user -d token_flow_db

# Check connection string
echo $POSTGRES_HOST $POSTGRES_PORT $POSTGRES_DB
```

### Helius API Errors

```bash
# Test Helius API key
curl -X GET "https://api.helius.xyz/v0/addresses/addresses" \
  -H "Authorization: Bearer $HELIUS_API_KEY"

# Check rate limits in Helius dashboard
# https://helius.xyz/dashboard
```

### Memory/Performance Issues

```bash
# Check resource usage
docker stats

# Scale services
docker-compose up -d --scale api=3

# Optimize database
docker-compose exec postgres psql -U token_flow_user -d token_flow_db -c "VACUUM ANALYZE;"
```

---

## 📈 Scaling Recommendations

### Horizontal Scaling

```yaml
# docker-compose.scale.yml
services:
  api:
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '1'
          memory: 1G

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - api
```

### Database Optimization

```sql
-- Create indexes for common queries
CREATE INDEX idx_transfers_from ON transfers(from_address);
CREATE INDEX idx_transfers_to ON transfers(to_address);
CREATE INDEX idx_transfers_timestamp ON transfers(timestamp);
CREATE INDEX idx_transfers_token ON transfers(token_mint);

-- Enable query plan analysis
EXPLAIN ANALYZE SELECT * FROM transfers WHERE from_address = '...';
```

### Redis Caching

```javascript
// services/api/src/services/cache.service.ts
import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

// Cache analysis results
await redis.setex(`analysis:${address}`, 3600, JSON.stringify(results));
```

---

## 🔐 Security Hardening

### Firewall Rules

```bash
# Allow only HTTPS traffic
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp  # SSH only
sudo ufw enable

# Or use AWS Security Groups / GCP Firewall Rules
```

### Rate Limiting (Nginx)

```nginx
# nginx.conf
http {
  limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

  server {
    location /api {
      limit_req zone=api_limit burst=20 nodelay;
      proxy_pass http://api:3000;
    }
  }
}
```

### DDoS Protection

- Use Cloudflare
- Enable AWS Shield (if on AWS)
- Configure rate limiting at multiple layers

---

## 📞 Post-Deployment Support

### Health Checks

```bash
# API health
curl https://api.yourdomain.com/health

# ML service health
curl https://api.yourdomain.com/api/v1/ml/health

# Database check
docker-compose exec postgres pg_isready
```

### Monitoring Checklist

- [ ] API response times < 200ms (p95)
- [ ] Error rate < 1%
- [ ] Database connections < 80% of max
- [ ] Memory usage < 80%
- [ ] Disk usage < 70%
- [ ] Helius API quota usage monitored

---

## 🎯 Quick Commands Reference

```bash
# Security validation
./scripts/validate-security.sh

# Run tests
./scripts/test-security-fixes.sh

# Start services
docker-compose up -d

# View logs
docker-compose logs -f api

# Restart services
docker-compose restart

# Stop services
docker-compose down

# Database backup
docker-compose exec postgres pg_dump -U token_flow_user token_flow_db > backup.sql

# Database restore
docker-compose exec -T postgres psql -U token_flow_user token_flow_db < backup.sql
```

---

## 📚 Additional Resources

- [Helius API Documentation](https://docs.helius.xyz)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Kubernetes Documentation](https://kubernetes.io/docs/)
- [OWASP Security Guidelines](https://owasp.org/)

---

**Remember:** Security is an ongoing process. Regularly review and update your security measures!

**Estimated Deployment Time:** 30-60 minutes (depending on infrastructure)

**Support:** For issues, check logs first, then refer to troubleshooting section above.
