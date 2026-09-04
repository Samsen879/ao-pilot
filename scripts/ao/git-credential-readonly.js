#!/usr/bin/env node

const operation = process.argv[2] ?? '';

if (operation === 'get') {
  const username = process.env.AO_GIT_PUBLICATION_CREDENTIAL_USERNAME ?? '';
  const password = process.env.AO_GIT_PUBLICATION_CREDENTIAL_PASSWORD ?? '';
  if (username !== '' && password !== '') {
    process.stdout.write(`username=${username}\npassword=${password}\n`);
  }
}

// Deliberately ignore `store` and `erase`: the publication probe is diagnostic.
