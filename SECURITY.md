# Security policy

Report a vulnerability in ARMOR-SERVER privately to `electrohobby3d@gmail.com`. Please do not publish it in a public issue before a fix exists.

Never put in an issue, a log or a screenshot: camera addresses and passwords, tokens, the set-up code of a node, the firmware signing key, the stored settings of a node or the addresses of a private network.

A.R.M.O.R. is a security system, so these are vulnerabilities: a way for something other than ARMOR-SERVER to authorise an action or to read a camera credential, a node or a client that accepts a request without authenticating it, and a firmware or a package that is installed without a valid SHA-256 and Ed25519 signature.

Only the latest release is supported.
