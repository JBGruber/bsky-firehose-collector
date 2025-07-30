library(tidyverse)
if (exists("con")) {
  DBI::dbDisconnect(con)
}

# the dbname, password etc are set in docker-compose.yml
con <- DBI::dbConnect(
  RPostgres::Postgres(),
  dbname = "collector-db",
  host = "10.6.13.115",
  port = 5432,
  user = "collector",
  password = "collector"
)

# see which tables exist
DBI::dbListTables(con)

posts <- tbl(con, "post") |>
  head(10000) |>
  collect()

deleted_posts <- tbl(con, "post") |>
  filter(!is.na(deletedAt)) |>
  collect()
