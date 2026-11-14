# Content manifest

The master copy of every source PDF lives in one shared folder owned by
buildminds: **`<MASTER DRIVE FOLDER - fill in the link>`**.

This repo does not store the PDFs. Each environment is filled by uploading
these files through its own dashboard (`Upload` on the PDFs tab). Staging
and dev never receive data from prod. The PDFs are the only content that
moves between environments, and each environment ingests them fresh from the
master folder.

Filenames must match exactly, including spaces. The golden evals
(`worker/evals/golden-cases.json`) look documents up by these names.

| Filename (exact) | Covers | Used by |
|---|---|---|
| `carbon compound notes.pdf` | Carbon compounds: covalent bonding, catenation, allotropes, homologous series of alkanes, functional groups (alcohols), IUPAC suffixes | Golden evals (staging), dev testing |
| `light notes.pdf` | Reflection and refraction: mirror formula, sign convention for concave mirrors, Snell's law, convex mirror images, lens power, real vs virtual images | Golden evals (staging), dev testing |
| `life Processes notes.pdf` | Life processes: photosynthesis, digestion (villi), aerobic and anaerobic respiration (ATP yield), excretion (nephrons), blood circulation | Golden evals (staging), dev testing |
| `control coordination test.pdf` | Control and coordination: a question paper used for question-paper generation tests (`qp-control-coordination`) | Golden evals (staging), dev testing |

## Adding a document

1. Put the PDF in the master folder with the exact filename.
2. Add a row to the table above with what it covers.
3. Upload it through the dashboard of each environment that needs it.
   Staging holds the eval PDFs. Prod gets only the documents students should see.
