library(tidyverse)
if (exists("con")) {
  DBI::dbDisconnect(con)
}

# the dbname, password etc are set in docker-compose.yml
con <- DBI::dbConnect(
  RPostgres::Postgres(),
  dbname = "collector-db",
  host = "localhost", #Sys.getenv("FEEDGEN_DB_HOST"), # "tux01ascor.fmg.uva.nl",#
  port = 5432,
  user = "collector",
  password = "collector"
)
DBI::dbListTables(con)

posts <- tbl(con, "post") |>
  head(10000) |>
  collect()

follows <- tbl(con, "follows") |>
  head(10000) |>
  collect()

deleted_posts <- tbl(con, "post") |>
  filter(!is.na(deletedAt)) |>
  collect()
