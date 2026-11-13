# Contributing

Thank you for looking. Arno Chat is a small project with one maintainer,
and it stays small on purpose: every feature has to earn its place, and
what is left out is named under **Left out** in the [README](README.md).

## Issues, not pull requests

Pull requests are turned off. If you found a bug or have an idea, open an
**issue** instead:

- **A bug**: what you did, what you expected, what happened instead, and
  the version (Settings → You → About shows the build and the app's
  version). A screenshot helps for anything you can see.
- **An idea**: the problem it solves for you, not only the feature. An
  idea that fits may be built; one that doesn't is answered with why.
- **A security problem**: don't open a public issue. Use GitHub's
  **Report a vulnerability** (the Security tab) so it stays private until
  it is mended.

Code you write in an issue (a fix, a patch) is welcome as a sketch. It
is read, and the change is made by the maintainer, in the project's own
style.

## Running your own

You are free to fork it and run your own deployment: the README's
**Get it** says how, or use the Deploy to Cloudflare button. The licence
is ISC.

## If you change your fork

```sh
npm install
npm test        # lint, format and unit tests: must pass
npm run fmt     # formats everything with prettier
```

`doc/ARCHITECTURE.md` explains the design, `doc/OPERATIONS.md` the
secrets and the runner image, and `doc/SECURITY.md` what the app
protects and how.
