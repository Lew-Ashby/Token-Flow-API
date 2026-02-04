# Root Dockerfile for Railway deployment
FROM node:20-alpine AS api-builder

WORKDIR /app/api

# Copy API package files
COPY services/api/package*.json ./
RUN npm install

# Copy API source
COPY services/api/tsconfig.json ./
COPY services/api/src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy built files
COPY --from=api-builder /app/api/package*.json ./
COPY --from=api-builder /app/api/node_modules ./node_modules
COPY --from=api-builder /app/api/dist ./dist

# Prune dev dependencies
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
