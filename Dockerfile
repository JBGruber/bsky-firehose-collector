FROM node:22-slim

WORKDIR /app

# Manifests first: a source change then reuses the cached install layer instead
# of reinstalling every dependency on every build.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

# The @atproto/* packages are ESM-only, so the collector is an ESM project and
# is compiled ahead of time rather than transpiled at container start. Nothing
# TypeScript-related is on the runtime path any more.
RUN yarn build

# Set environment variables
ENV NODE_ENV=production
ENV COLLECTOR_LISTENHOST=0.0.0.0

# Expose the port that the application listens on
EXPOSE 3000

# node directly, not `yarn start`: yarn does not forward SIGTERM to its child,
# so with yarn as PID 1 `docker stop` killed the collector outright -- the
# shutdown handler never ran and the buffered batch and its cursor were lost on
# every restart. Exit code was 1; with node as PID 1 it is 0.
CMD ["node", "dist/index.js"]
