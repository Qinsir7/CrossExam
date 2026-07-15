FROM node:22.2.0-bookworm-slim

ENV NODE_ENV=production
ENV CROSSEXAM_PORT=4022
ENV CROSSEXAM_DATA_DIR=/var/lib/crossexam

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY src ./src

RUN mkdir -p /var/lib/crossexam && chown -R node:node /app /var/lib/crossexam

USER node
EXPOSE 4022

CMD ["npm", "run", "x402:serve"]
