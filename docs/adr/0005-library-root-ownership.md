# Library and root ownership

A library has one media kind and one or more server-side roots. Roots are canonicalized, checked for overlap, and treated as read-only inputs. Scanning reconciles one root generation at a time; an unavailable or interrupted root never marks its media deleted.
