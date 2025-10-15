# Bluesky Firehose collector

Sets up a PostgreSQL database and continuously fills it with everything that happens on Bluesky.
To run, download the [docker-compose.yml](https://raw.githubusercontent.com/JBGruber/newsflows-bsky-firehose-collector/refs/heads/main/docker-compose.yml) file and run it with:

```bash
docker compose up -d
```

[get_data](scripts/get_data.R) contains a minimal example of how to query the data from `R`.

## Build and upload

``` bash
docker-compose down && \
  docker-compose build --no-cache && \
  docker-compose up -d
```

Then push to dockerhub.

``` bash
docker image push jbgruber/bsky-firehose-collector:latest
```