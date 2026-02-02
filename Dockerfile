FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
ARG CACHEBUST=1
COPY . .
EXPOSE 3000
CMD ["node", "server.mjs"]
