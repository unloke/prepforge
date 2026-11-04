# Rejected documentation-rate formula

This approach was removed, including its implementation, derived tree, scores and verification scripts. It must not be used as a quality grade.

The trial averaged four annotation-presence ratios: decision notes, fork signposts, endpoint notes and starting notes. It counted local prose without understanding its truth, relevance or teaching role. The frozen trial covered 38 studies and used scorer hash `8de9b88e47ee41955e90629b422b13cbf70598d127488fae23753d3c01068ff9`.

Against direct manual reviews (14 high, 20 medium, 4 low), high-versus-low AUC was **0.732** and ordinal Spearman correlation **0.045**. Mean trial scores were high **46.39**, medium **55.56**, low **26.86**. These exploratory comparisons reused the design corpus; they were not independent validation. Near-zero ordinal association and concrete counterexamples reject the intended overall-quality interpretation.

False positive: **2MMWpcNI scored 92.36**, despite [review B](review-b.md) finding confused opening/color explanations and unsupported rating tiers. **PDVt7Kbh scored 40.63**, despite [review C](review-c.md) finding useful thematic explanations and purpose warnings. Companion notes **FwXo3Qhq scored 6.91** despite high clarity for their stated limited role. More notes are not necessarily better teaching; intentional demonstrations and sparingly annotated useful reference material must be read in context.

Generic prose could inflate these ratios, and deleting undocumented branches could improve them while removing useful content. Duplication controls did not solve that construct failure. No weights were fitted to likes or manual labels. The retained deliverable is the [manual catalog](catalog.md), source snapshots and concrete review evidence, without a replacement automatic grade.
