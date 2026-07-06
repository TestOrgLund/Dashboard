import fs from "fs";
import { graphql } from "@octokit/graphql";

// ---------------------------
// Config
// ---------------------------

const config = JSON.parse(
  fs.readFileSync("./config/config.json", "utf8")
);

const ORG = config.org;

const gh = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GH_TOKEN}`
  }
});

// ---------------------------
// Logging
// ---------------------------

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------
// GraphQL helper
// ---------------------------

async function execute(query, variables = {}) {

  return await gh(query, variables);
}

// ---------------------------
// Generic pagination helper
// ---------------------------

async function getAllPages(query, variables, extract) {

  let cursor = null;
  let results = [];

  while (true) {

    const res = await execute(query, {
      ...variables,
      cursor
    });

    const conn = extract(res);

    results.push(...conn.nodes);

    if (!conn.pageInfo.hasNextPage) {
      break;
    }

    cursor = conn.pageInfo.endCursor;
  }

  return results;
}

// ---------------------------
// Get all projects in org
// ---------------------------

async function getProjects() {

  const query = `
    query($org: String!, $cursor: String) {

      organization(login: $org) {

        projectsV2(first: 100, after: $cursor) {

          nodes {
            id
            title
          }

          pageInfo {
            hasNextPage
            endCursor
          }

        }

      }

    }
  `;

  return await getAllPages(
    query,
    { org: ORG },
    r => r.organization.projectsV2
  );
}

// ---------------------------
// Search issues (AND labels)
// ---------------------------

async function searchIssues(labels) {

  const labelQuery = labels
    .map(l => `label:"${l}"`)
    .join(" ");

  const q = `org:${ORG} is:issue is:open ${labelQuery}`;

  log(`Searching: ${q}`);

  const query = `
    query($q: String!, $cursor: String) {

      search(query: $q, type: ISSUE, first: 100, after: $cursor) {

        nodes {
          ... on Issue {
            id
            number
            title
            url

            repository {
              nameWithOwner
            }
          }
        }

        pageInfo {
          hasNextPage
          endCursor
        }

      }

    }
  `;

  return await getAllPages(
    query,
    { q },
    r => r.search
  );
}

// ---------------------------
// Get existing issues in ProjectV2 (DEDUP)
// ---------------------------

async function getProjectIssueIds(projectId) {

  const query = `
    query($projectId: ID!, $cursor: String) {

      node(id: $projectId) {

        ... on ProjectV2 {

          items(first: 100, after: $cursor) {

            nodes {

              content {
                ... on Issue {
                  id
                }
              }

            }

            pageInfo {
              hasNextPage
              endCursor
            }

          }

        }

      }

    }
  `;

  const items = await getAllPages(
    query,
    { projectId },
    r => r.node.items
  );

  return new Set(
    items
      .map(i => i.content?.id)
      .filter(Boolean)
  );
}

// ---------------------------
// Add issue to project
// ---------------------------

async function addToProject(projectId, contentId) {

  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {

      addProjectV2ItemById(input: {
        projectId: $projectId,
        contentId: $contentId
      }) {

        item {
          id
        }

      }

    }
  `;

  await execute(mutation, {
    projectId,
    contentId
  });
}

// ---------------------------
// Sync one project
// ---------------------------

async function syncProject(cfg, project) {

  log(`\n=== ${cfg.projectName} ===`);

  const issues = await searchIssues(cfg.labels);

  log(`Found ${issues.length} issues`);

  // 🔥 HAMTA EXISTING STATE
  const existing = await getProjectIssueIds(project.id);

  log(`Already in project: ${existing.size}`);

  let added = 0;
  let skipped = 0;

  for (const issue of issues) {

    // 🔥 DEDUPE CHECK
    if (existing.has(issue.id)) {
      skipped++;
      continue;
    }

    log(`➕ Adding ${issue.repository.nameWithOwner}#${issue.number}`);

    await addToProject(project.id, issue.id);

    // viktig: uppdatera state lokalt också
    existing.add(issue.id);

    added++;
  }

  log(`Done: added ${added}, skipped ${skipped}`);
}

// ---------------------------
// MAIN
// ---------------------------

async function main() {

  log("Starting sync...");

  const projects = await getProjects();

  for (const cfg of config.projects) {

    const project = projects.find(
      p => p.title === cfg.projectName
    );

    if (!project) {
      log(`❌ Missing project: ${cfg.projectName}`);
      continue;
    }

    await syncProject(cfg, project);
  }

  log("Finished.");
}

main();