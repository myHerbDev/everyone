/**
 * Copyright 2024, Arhan Chaudhary, All rights reserved.
 *
 * This program is *solely* intended for educational purposes. I love making
 * software public, but I kindly request for you to be mindful and avoid misuse
 * relating to email harvesting/spamming.
 *
 * Please familiarize yourself with GitHub's Acceptable Use Policies on:
 *
 * Impersonation https://docs.github.com/en/site-policy/acceptable-use-policies/github-impersonation
 * Spam and Inauthentic Activity https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github
 * Information Usage Restrictions https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#7-information-usage-restrictions
 * API Terms https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms
 * Excessive Bandwidth Use https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#9-excessive-bandwidth-use
 *
 * And make sure your use of information complies with the GitHub Privacy Statement:
 *
 * https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
 *
 * Thank you!
 */

// Note that not every co-author may be valid
const CO_AUTHOR_COUNT = parseInt(
  process.argv
    .find((arg) => arg.startsWith("--co-author-count="))
    ?.substring(18)
);
// how many followers to start searching from in descending order, set to
// Infinity to start from most followed users
const INITIAL_MAX_FOLLOWERS = Infinity;
// how many users to process in a single graphql query, 85 is around optimal
const BATCH_USER_COUNT = 85;
// how many concurrent email queries to make, any more than this gets secondary
// rate limited a lot and has diminishing returns
const CONCURRENCY_COUNT = 3;
// around how many co authors to get for each search user, set to Infinity to
// search every follower
const SEARCH_USER_FOLLOWERS_DEPTH = 500;

if (Number.isNaN(CO_AUTHOR_COUNT)) {
  console.error(
    `Invalid co_author_count argument: ${process.argv[2]}
Usage: index.mjs --co-author-count=[N]`
  );
  process.exit(1);
}

import { stripIgnoredCharacters } from "graphql/utilities/stripIgnoredCharacters.js";
import { Octokit } from "octokit";

const octokit = new Octokit({
  auth: process.env.GH_PAT,
  throttle: {
    onRateLimit: (retryAfter, options, octokit) => {
      console.warn(
        `[WARNING] Request quota exhausted for request ${options.method} ${options.url}`
      );

      if (options.request.retryCount === 0) {
        let now = new Date();
        now.setSeconds(now.getSeconds() + retryAfter);
        console.warn(
          `[WARNING] Retrying after ${retryAfter} seconds: ${now.toISOString()}`
        );
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options, octokit) => {
      console.warn(
        `[WARNING] SecondaryRateLimit detected for request ${options.method} ${options.url}`
      );

      if (options.request.retryCount === 0) {
        let now = new Date();
        now.setSeconds(now.getSeconds() + retryAfter);
        console.warn(
          `[WARNING] Retrying after ${retryAfter} seconds: ${now.toISOString()}`
        );
        return true;
      }
    },
  },
});

function filterInPlace(array, predicate) {
  for (let i = array.length - 1; i >= 0; i--) {
    if (!predicate(array[i])) {
      array.splice(i, 1);
    }
  }
}

function emailsFromUsersQuery(users, batchIndex) {
  return stripIgnoredCharacters(`
    {
      ${users
        .slice(
          batchIndex * BATCH_USER_COUNT,
          (batchIndex + 1) * BATCH_USER_COUNT
        )
        .map(
          ({ login, id }, index) => `
            _${index + batchIndex * BATCH_USER_COUNT}: user(login: "${login}") {
              repositories(first: 1, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) {
                nodes {
                  defaultBranchRef {
                    target {
                      ... on Commit {
                        history(first: 1, author: { id: "${id}" }) {
                          nodes {
                            author {
                              email
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `
        )
        .join("\n")}
    }
  `);
}

async function* coAuthorsFromUsersIterator(usersBatch, seenUsers) {
  let jsonWithEmailsPromises = [];
  for (let i = 0; i < CONCURRENCY_COUNT; i++) {
    let query = emailsFromUsersQuery(usersBatch, i);
    let jsonWithEmailPromise = octokit
      .graphql(query)
      .then((jsonWithEmails) => jsonWithEmails || Promise.reject())
      .catch((e) => {
        console.error(
          `[ERROR] Error deriving emails for query ${query}: ${e.toString()}`
        );
        usersBatch.fill(null, i * BATCH_USER_COUNT, (i + 1) * BATCH_USER_COUNT);
      });
    jsonWithEmailsPromises.push(jsonWithEmailPromise);
  }

  for (let jsonWithEmails of await Promise.all(jsonWithEmailsPromises)) {
    if (!jsonWithEmails) {
      // was caught
      continue;
    }
    for (let [i, jsonWithEmail] of Object.entries(jsonWithEmails)) {
      // ?.history is needed to not crash on corrupted repositories
      let email =
        jsonWithEmail.repositories.nodes[0]?.defaultBranchRef?.target?.history
          .nodes[0]?.author.email;
      // the query label was prefixed by "_"
      i = i.substring(1);
      let user = usersBatch[i];
      // null indicates user was processed and should be removed from the batch
      if (
        email?.endsWith("@users.noreply.github.com") &&
        !seenUsers.has(user.id)
      ) {
        usersBatch[i] = null;
        seenUsers.add(user.id);
        yield `Co-authored-by: ${user.login} <${email}>`;
      } else {
        usersBatch[i] = null;
      }
    }
  }
}

async function* followerCoAuthorsIterator(rootUser, usersBatch, seenUsers) {
  let rootUserFollowersIterator = octokit.graphql.paginate.iterator(
    stripIgnoredCharacters(`
      query($cursor: String) {
        user(login: "${rootUser.login}") {
          followers(first: 100, after: $cursor) {
            nodes {
              login
              id
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `)
  );

  // I don't *think* this is necessary, but the logic is very fragile so lets
  // just be safe
  filterInPlace(usersBatch, (user) => user !== null);
  // there are still followers to be processed from the previous user, adjust
  // for that
  let followerCoAuthorCount = -usersBatch.length;
  while (followerCoAuthorCount < SEARCH_USER_FOLLOWERS_DEPTH) {
    // if false, one batch wasn't enough; keep batching the group of users
    if (usersBatch.length < BATCH_USER_COUNT * CONCURRENCY_COUNT) {
      try {
        for await (let jsonWithFollowers of rootUserFollowersIterator) {
          usersBatch.push(...jsonWithFollowers.user.followers.nodes);
          if (usersBatch.length >= BATCH_USER_COUNT * CONCURRENCY_COUNT) {
            break;
          }
        }
        if (usersBatch.length < BATCH_USER_COUNT * CONCURRENCY_COUNT) {
          console.warn(
            `[WARNING] Only processed ${usersBatch.length}/${SEARCH_USER_FOLLOWERS_DEPTH} followers from user ${rootUser.login}`
          );
          return;
        }
      } catch (e) {
        console.error(
          `[ERROR] Error fetching followers for ${
            rootUser.login
          }: ${e.toString()}`
        );
        return;
      }
    }
    for await (let coAuthor of coAuthorsFromUsersIterator(
      usersBatch,
      seenUsers
    )) {
      yield coAuthor;
      followerCoAuthorCount++;
    }
    filterInPlace(usersBatch, (user) => user !== null);
  }
}

async function* searchUsersIterator(searchMaxFollowers) {
  let _searchUsersIterator = octokit.graphql.paginate.iterator(
    stripIgnoredCharacters(`
      query($cursor: String) {
        search(query: "${
          searchMaxFollowers === Infinity
            ? "followers:>=0"
            : `followers:<${searchMaxFollowers}`
        }", type: USER, first: 100, after: $cursor) {
          nodes {
            ... on User {
              login
              id
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
  `)
  );
  try {
    for await (let jsonWithSearchUsers of _searchUsersIterator) {
      for (let searchUser of jsonWithSearchUsers.search.nodes) {
        // can timeout and return an empty object
        if (Object.keys(searchUser).length !== 0) {
          yield searchUser;
        }
      }
    }
  } catch (e) {
    console.error(`[ERROR] Error fetching search users: ${e.toString()}`);
  }
}

async function* coAuthorsIterator() {
  // I know... but this needs to be sequential or else github complains
  // about secondary rate limits
  let usersBatch = [];
  let seenUsers = new Set();
  let maxFollowers = INITIAL_MAX_FOLLOWERS;
  let minFollowersLogin;
  while (true) {
    for await (let searchUser of searchUsersIterator(maxFollowers)) {
      console.warn(
        `[INFO] Processing followers for ${searchUser.login} at ${Math.round(
          (new Date() - start) / 1000
        )} seconds in`
      );
      minFollowersLogin = searchUser.login;
      for await (let coAuthor of followerCoAuthorsIterator(
        searchUser,
        usersBatch,
        seenUsers
      )) {
        yield coAuthor;
      }
    }
    if (minFollowersLogin) {
      // if this fails, tough luck
      ({
        user: {
          followers: { totalCount: maxFollowers },
        },
      } = await octokit.graphql(
        stripIgnoredCharacters(`
          {
            user(login: "${minFollowersLogin}") {
              followers {
                totalCount
              }
            }
          }
        `)
      ));
    }
  }
}

let coAuthorCount = 0;
let start = new Date();
for await (let coAuthor of coAuthorsIterator()) {
  console.log(coAuthor);
  if (++coAuthorCount >= CO_AUTHOR_COUNT) {
    break;
  }
}
if (coAuthorCount < CO_AUTHOR_COUNT) {
  console.warn(
    `[WARNING] Only processed ${coAuthorCount}/${CO_AUTHOR_COUNT} co-authors`
  );
}
console.warn(`\nDone in ${Math.round((new Date() - start) / 1000)} seconds!`);
