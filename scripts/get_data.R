library(tidyverse)
if (exists("con")) {
  DBI::dbDisconnect(con)
}

# the dbname, password etc are set in docker-compose.yml
con <- DBI::dbConnect(
  RPostgres::Postgres(),
  dbname = "collector-db",
  host = "localhost",
  port = 5432,
  user = "collector",
  password = "collector"
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

# get deleted posts
deleted_posts <- tbl(con, "post") |>
  filter(!is.na(deletedAt)) |>
  collect()


deletion_data <- tbl(con, "post") |>
  filter(!is.na(deletedAt)) |>
  mutate(time_online = as_datetime(deletedAt) - as_datetime(indexedAt)) |>
  select(indexedAt, deletedAt, time_online) |>
  collect() |>
  mutate(
    time_online = as.difftime(time_online, units = "secs"),
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
    y = max(counts) * 1.1, # Slightly above max
    label = c("1 min", "5 min", "10 min", "15 min\nand over"),
    color = "white",
    hjust = 0.5,
    vjust = 1
  ) +
  labs(
    x = NULL,
    y = NULL,
    title = "seconds posts were online before deletion"
  ) +
  hrbrthemes::theme_ft_rc()
