library(tidyverse)
if (exists("con")) {
  DBI::dbDisconnect(con)
}
readRenviron(".env")

# the dbname, password etc are set in docker-compose.yml
con <- DBI::dbConnect(
  RPostgres::Postgres(),
  dbname = "collector-db",
  host = "localhost", #Sys.getenv("db_host"),
  port = 5432,
  user = "collector",
  password = Sys.getenv("db_pw")
)

# pull data from 2025-08-01 until 2025-10-01.
# createdAt is timestamptz now, so the filter no longer needs as_datetime() --
# which is the point: the cast made post_createdAt_index unusable and turned
# this into a full scan of the table.
deleted_posts <- tbl(con, "post") |>
  # comment out the join to get the full dataset
  inner_join(tbl(con, "post_deletion"), by = "uri") |>
  filter(
    createdAt >= "2025-08-01",
    createdAt < "2025-10-01"
  ) |>
  collect() |>
  # an edited post can appear once per version; keep the first
  arrange(uri, indexedAt) |>
  distinct(uri, .keep_all = TRUE)

# add engagment, counting withdrawn likes and reposts separately rather than
# losing them: engagement_deletion is what used to be a hard DELETE
withdrawn <- tbl(con, "engagement_deletion") |>
  select(uri, deletedAt)

engagement <- tbl(con, "engagement") |>
  filter(subjectUri %in% deleted_posts$uri) |>
  select(uri, subjectUri, type) |>
  left_join(withdrawn, by = "uri") |>
  collect() |>
  group_by(uri = subjectUri) |>
  summarise(
    reposts = sum(type == 1L),
    likes = sum(type == 2L),
    reposts_withdrawn = sum(type == 1L & !is.na(deletedAt)),
    likes_withdrawn = sum(type == 2L & !is.na(deletedAt))
  )

deleted_posts_w_enagement <- deleted_posts |>
  left_join(engagement, by = "uri")

rio::export(deleted_posts_w_enagement, "bsky_posts_w_enagement.csv.zip")
