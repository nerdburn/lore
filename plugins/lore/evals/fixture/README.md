Synthetic context repo the plugin evals run against — a fictional client
("Acme"), two Slack messages, three GitHub events, a GitHub work table with one open
PR, and derived artifacts citing them. No real client data. Each case's
scaffold.sh copies this directory into the eval sandbox.

The lore tracker (`context/work/lore/ACM.yaml`) holds two tickets: ACM-1, the
Black Friday landing page, in progress (moved by the fold when PR #42 opened),
and ACM-2, mirrored from GitHub issue #40 and closed when it closed.
