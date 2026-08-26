library(tidyverse)
if (exists("con")) {
  DBI::dbDisconnect(con)
}
readRenviron(".env")

# the dbname, password etc are set in docker-compose.yml
con <- DBI::dbConnect(
  RPostgres::Postgres(),
  dbname = "collector-db",
  host = Sys.getenv("db_host", unset = "localhost"),
  port = 5432,
  user = "collector",
  password = Sys.getenv("db_pw", unset = "collector")
)

# see which tables exist
DBI::dbListTables(con)

# how many posts did we collect already?
tbl(con, "post") |>
  count()

# get 10k posts
posts <- tbl(con, "post") |>
  head(10000) |>
  collect()

# check out engagement
tbl(con, "engagement") |>
  select(type) |>
  collect() |>
  mutate(type = c("repost", "like")[type]) |>
  count(type)

# engagement that was later withdrawn -- un-likes and un-reposts are kept now
# instead of being deleted outright
tbl(con, "engagement_deletion") |>
  count()

# Deletions live in their own append-only table now, rather than as a deletedAt
# column written back over the post row. Timestamps are timestamptz, so they
# arrive as POSIXct and need no parsing.
tbl(con, "post_deletion") |>
  count()

# A post that was edited can appear more than once, keyed (uri, indexedAt); the
# first version is the one to keep. Deduplicated after collect() because the
# join already narrows to deleted posts.
first_version <- function(d) {
  d |>
    arrange(uri, indexedAt) |>
    distinct(uri, .keep_all = TRUE)
}

# get deleted posts
deleted_posts <- tbl(con, "post") |>
  inner_join(tbl(con, "post_deletion"), by = "uri") |>
  collect() |>
  first_version()

deletion_data <- tbl(con, "post") |>
  select(uri, indexedAt) |>
  inner_join(tbl(con, "post_deletion") |> select(uri, deletedAt), by = "uri") |>
  collect() |>
  first_version() |>
  mutate(
    time_online = as.difftime(
      as.numeric(difftime(deletedAt, indexedAt, units = "secs")),
      units = "secs"
    ),
    time_online_int = as.integer(time_online),
    time_online_int_clean = ifelse(time_online_int > 900, 901, time_online_int)
  )

# Calculate max count for positioning
counts <- (deletion_data |>
  ggplot(aes(time_online_int_clean)) +
  geom_histogram(bins = 30)) |>
  ggplot_build() |>
  pluck("data", 1) |>
  pull(count)

deletion_data |>
  ggplot(aes(time_online_int_clean)) +
  geom_histogram(bins = 30) +
  # Arrows pointing to vertical lines
  annotate(
    "segment",
    x = c(60, 300, 600, 900),
    xend = c(60, 300, 600, 900),
    y = max(counts) * 1,
    yend = counts[c(3, 11, 21, 30)] * 1.1,
    color = "white",
    alpha = 0.7,
    arrow = arrow(length = unit(0.3, "cm"))
  ) +
  # Text at top
  annotate(
    "text",
    x = c(60, 300, 600, 900),
    y = max(counts) * 1.2, # Slightly above max
    label = c("1 min", "5 min", "10 min", "15 min\nand over"),
    color = "white",
    hjust = 0.5,
    vjust = 1
  ) +
  scale_y_continuous(limits = c(0, max(counts) * 1.2), labels = scales::comma) +
  labs(
    x = NULL,
    y = NULL,
    title = "seconds posts were online before deletion",
    caption = glue::glue("N = {scales::comma(nrow(deletion_data))}")
  ) +
  hrbrthemes::theme_ft_rc()


deletion_data |>
  ggplot(aes(time_online)) +
  geom_histogram(bins = 30)
