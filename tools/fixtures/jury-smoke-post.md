# The 34 Minute Feedback Loop That Was Quietly Eating My Team

For about seven months I carried a line item in the platform backlog that
read "investigate CI duration." It moved down the board every planning
session because nothing was on fire. Nothing was on fire because the thing
it was burning was attention, and attention does not page anyone at 3am.

The number that finally moved me was not a CI number at all. It was pull
request cycle time. Median time from first commit to merge on my team had
drifted from 1.9 days to 3.2 days over two quarters, while story points per
sprint stayed flat at roughly 34. We were not slower at writing code. We
were slower at finishing it.

So I did the boring thing and pulled the raw pipeline data for one month.
1,742 workflow runs. Median wall clock 34 minutes, p95 51 minutes.
It's worth noting that our stated internal target was 10 minutes,
a number nobody had looked at since it was written in 2023.

## Where the 34 minutes actually went

I expected the answer to be spread across a dozen small things. It was not.
Two stages accounted for 71% of the median run.

The first was a Docker build that rebuilt the entire dependency layer on
every single run. Our cache key included the full commit SHA, so it never
hit. Not "rarely hit." Never. In 1,742 runs the layer cache had a hit rate
of 0%. Someone had added the SHA in order to fix a stale cache bug in 2024,
the bug was real, and the fix basically disabled caching forever. Nobody
noticed because the pipeline still went green.

The second was a single integration suite, 312 tests, running serially
against one Postgres container. 14 minutes of the 34. The suite had grown
from 40 tests to 312 over three years, one honest test at a time, and no
one had ever gone back to ask whether serial was still the right shape.

## The fix was four lines and one afternoon

The cache key change was genuinely four lines. We keyed on the lockfile
hash with a branch-scoped fallback chain instead of the commit SHA:

```yaml
- uses: actions/cache@v4
  with:
    path: /var/lib/docker/buildkit
    key: buildkit-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      buildkit-${{ runner.os }}-
```

Cache hit rate went from 0% to 94% inside a day. The build stage dropped
from 11 minutes to 90 seconds on a hit.

The integration suite took longer, about three days of one engineer's time.
We sharded it across 4 runners with a per-shard database, which is not
clever, just something we had been too busy to do. 14 minutes became 4.

## What it bought

Median pipeline time went from 34 minutes to 9. p95 went from 51 to 16. PR
cycle time came down to 1.4 days over the following six weeks, which is
better than where we started before the drift. CI spend dropped from $4,200
a month to $2,650 even though we were running 12% more jobs, because we
were paying for 25 minutes of pointless rebuild on every push.

The part I keep coming back to is the cost of the seven months. At 1,742
runs a month and 25 wasted minutes per run, we spent something like 725
engineer-hours of waiting per month across the org. Not all of that is real
lost time, since people context switch. Context switching is the cost.

## The leadership failure, which was mine

The technical problem was easy. Any of my engineers could have fixed it in
a week, and at this point in time I think several of them knew roughly
where the fat was. The reason it sat for seven months is that I never gave
it an owner or a number.

"Investigate CI duration" is not a task. It is a feeling. It has no
definition of done, no baseline, and no one whose week gets worse if it
does not happen. It sat next to items that had all three, and it lost every
time, exactly as it should have.

What changed was that I wrote it as "median CI wall clock under 12 minutes
by end of quarter, owner Dana." Same work, same team, same backlog. It
shipped in eight working days.

I have started applying a rule to my own planning: if a backlog item does
not have a number in its title, it is not a backlog item, it is a note to
myself. Notes to myself are fine. They just should not be allowed to
leverage a slot on the board and pretend to be work.

The 34 minutes were never really the problem. The problem was that I let
something expensive stay invisible because it never turned red.
