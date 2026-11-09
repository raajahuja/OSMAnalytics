# Licensing notes for a public site

This is a practical summary of what was checked on 9 November 2026. It is not legal advice. The [ODbL text](https://opendatacommons.org/licenses/odbl/1-0/) takes precedence over the guidance linked here.

## How the licence applies

| What this project has | ODbL term | What follows |
|---|---|---|
| Web pages, maps and charts shown to visitors | Produced Work | Can carry any licence, but must credit OpenStreetMap. |
| `output/analytics/*.sqlite` and vector tiles | Derivative Database | Stays under the ODbL if you distribute it. |
| Data served to visitors through the public API | Public use of a Derivative Database | Treat as covered by the ODbL. |

## What the site must do

1. **Credit OpenStreetMap.** The credit must name OpenStreetMap, make clear the data is under the ODbL, and sit where users expect it. The page footer already links "© OpenStreetMap contributors" to the copyright page, and links ODbL 1.0. See the [attribution guideline](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines).
2. **Be ready to share the derived data.** Anyone who receives a Produced Work can ask for a copy of the underlying data and any Derivative Database used to make it. See the [licence FAQ](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ). The simplest way to comply is to publish the databases, or the build scripts and instructions that recreate them from the public OSM extract.
3. **Keep other sources credited.** The Luxembourg canton boundaries are CC BY 4.0 from ACT Luxembourg, harmonized by SIG-GR. The Luxembourg aerial imagery comes from data.public.lu. Both are credited in the app.

## Open decision

Before launch, choose how you will meet point 2, and consider having a lawyer confirm it. Mixing OSM data with a proprietary dataset in the same database would extend these obligations, so review that before adding new sources.
