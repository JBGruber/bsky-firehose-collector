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

# pull data from 2025-08-01 until 2025-08-08
deleted_posts <- tbl(con, "post") |>
  # comment out filter to get full dataset
  filter(!is.na(deletedAt)) |>
  filter(
    as_datetime(createdAt) >= "2025-08-01",
    as_datetime(createdAt) < "2025-10-01"
  ) |>
  collect()

# add engagment
engagement <- tbl(con, "engagement") |>
  filter(subjectUri %in% deleted_posts$uri) |>
  select(uri = subjectUri, type) |>
  collect() |>
  group_by(uri) |>
  summarise(
    reposts = sum(type == 1L),
    likes = sum(type == 2L)
  )

deleted_posts_w_enagement <- deleted_posts |>
  left_join(engagement, by = "uri")

rio::export(deleted_posts_w_enagement, "bsky_posts_w_enagement.csv.zip")
