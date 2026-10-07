SQLite, median of 31 runs; 300 games; batches of 100.

| Operation | Nodes | Before ms / SQL | After ms / SQL |
|---|---:|---:|---:|
| load_repertoire | 50 | 2.50 / 2 | 2.40 / 2 |
| workspace_after_move | 50 | 1.09 / 3 | 1.02 / 3 |
| list_health_due | 50 | 2.50 / 3 | 2.40 / 3 |
| dashboard_api | 50 | 5.16 / 12 | 4.95 / 12 |
| build_add_moves_api | 50 | 8.95 / 11 | 9.26 / 11 |
| build_delete_nodes_api | 50 | 8.40 / 13 | 8.40 / 13 |
| smart_start_api | 50 | 9.51 / 15 | 9.14 / 15 |
| smart_move_api | 50 | 8.07 / 13 | 7.98 / 13 |
| match_one_game | 50 | 1.89 / 0 | 1.86 / 0 |
| match_game_batch | 50 | 187.22 / 0 | 180.15 / 0 |
| departure_ingest_batch | 50 | 2.04 / 6 | 2.01 / 6 |
| load_repertoire | 500 | 22.86 / 2 | 22.31 / 2 |
| workspace_after_move | 500 | 3.28 / 3 | 3.39 / 3 |
| list_health_due | 500 | 4.68 / 3 | 4.44 / 3 |
| dashboard_api | 500 | 7.38 / 12 | 5.97 / 12 |
| build_add_moves_api | 500 | 38.66 / 11 | 37.94 / 11 |
| build_delete_nodes_api | 500 | 38.37 / 13 | 37.54 / 13 |
| smart_start_api | 500 | 32.21 / 15 | 32.69 / 15 |
| smart_move_api | 500 | 30.48 / 13 | 28.87 / 13 |
| match_one_game | 500 | 1.93 / 0 | 1.95 / 0 |
| match_game_batch | 500 | 191.16 / 0 | 189.99 / 0 |
| departure_ingest_batch | 500 | 2.24 / 6 | 2.20 / 6 |
| load_repertoire | 2000 | 91.31 / 2 | 88.92 / 2 |
| workspace_after_move | 2000 | 11.20 / 3 | 11.80 / 3 |
| list_health_due | 2000 | 12.78 / 3 | 12.87 / 3 |
| dashboard_api | 2000 | 11.35 / 12 | 10.87 / 12 |
| build_add_moves_api | 2000 | 140.55 / 11 | 140.71 / 11 |
| build_delete_nodes_api | 2000 | 141.87 / 13 | 143.41 / 13 |
| smart_start_api | 2000 | 108.12 / 15 | 107.99 / 15 |
| smart_move_api | 2000 | 99.25 / 13 | 98.71 / 13 |
| match_one_game | 2000 | 2.30 / 0 | 2.27 / 0 |
| match_game_batch | 2000 | 225.65 / 0 | 225.23 / 0 |
| departure_ingest_batch | 2000 | 2.14 / 6 | 2.01 / 6 |
