FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --production

# Copy all source - Railway rebuilds on every push so this layer updates
COPY . .

# Verify index.html has our latest code (build-time sanity check)
RUN grep -q "live-stats" index.html && echo "OK: index.html is up to date" || (echo "FAIL: stale index.html" && exit 1)

EXPOSE 3000
CMD ["node", "server.mjs"]
