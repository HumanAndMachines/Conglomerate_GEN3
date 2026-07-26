#!/usr/bin/env perl
use strict;
use warnings;

# POSIX mkdir(2) returns no directory handle. A separate openat/open(2) is
# vulnerable to a directory replacement between creation and anchoring, so
# nested manifest materialization is deliberately unavailable on this platform.
print '{"ok":false,"outcome":"failed","code":"materialization_anchor_unavailable","message":"POSIX nemá schválený atomický create-and-handle primitive; target nebyl vytvořen."}', "\n";
exit 20;
