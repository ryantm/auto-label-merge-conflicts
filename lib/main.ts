import * as core from '@actions/core';
import * as github from '@actions/github';
import { IGithubLabelNode, IGithubPRNode } from './interfaces';
import {
  addLabelsToLabelable,
  getLabels,
  getPullRequests,
  removeLabelsFromLabelable
} from './queries';
import { getPullrequestsWithoutMergeStatus, wait } from './util';

export async function run() {
  const conflictLabelName = core.getInput('CONFLICT_LABEL_NAME', {
    required: true
  });
  const myToken = core.getInput('GITHUB_TOKEN', {
    required: true
  });

  const octokit = new github.GitHub(myToken);
  const maxRetries = 60;
  const waitMs = 60000;

  // fetch label data
  let labelData;
  try {
    labelData = await getLabels(octokit, github.context, conflictLabelName);
  } catch (error) {
    core.setFailed('getLabels request failed: ' + error);
  }

  let conflictLabel: IGithubLabelNode;

  if (labelData) {
    // note we have to iterate over the labels despite the 'query' since query match is quite fuzzy
    conflictLabel = labelData.repository.labels.edges.find(
      (label: IGithubLabelNode) => {
        return label.node.name === conflictLabelName;
      }
    );

    if (!conflictLabel) {
      core.setFailed(
        `"${conflictLabelName}" label not found in your repository!`
      );
    }
  }

  let pullRequests!: IGithubPRNode[];

  // fetch PRs up to $maxRetries times
  // multiple fetches are necessary because Github computes the 'mergeable' status asynchronously, on request,
  // which might not be available directly after the merge
  let pullrequestsWithoutMergeStatus: IGithubPRNode[] = [];
  let tries = 0;
  while (
    (pullrequestsWithoutMergeStatus.length > 0 && tries < maxRetries) ||
    tries === 0
  ) {
    tries++;
    // if merge status is unknown for any PR, wait a bit and retry
    if (pullrequestsWithoutMergeStatus.length > 0) {
      core.debug(`...waiting for mergeable info (try ${tries}/${maxRetries})...`);
      await wait(waitMs);
    }

    try {
      pullRequests = await getPullRequests(octokit, github.context);
    } catch (error) {
      core.setFailed('getPullRequests request failed: ' + error);
    }

    // check if there are PRs with unknown mergeable status
    pullrequestsWithoutMergeStatus = getPullrequestsWithoutMergeStatus(
      pullRequests
    );
  }

  // after $maxRetries we give up, probably Github has some issues
  if (pullrequestsWithoutMergeStatus.length > 0) {
    core.setFailed('Cannot determine mergeable status!');
  }

  let pullrequestsWithConflicts: IGithubPRNode[];
  pullrequestsWithConflicts = pullRequests.filter(
    (pullrequest: IGithubPRNode) => {
      return pullrequest.node.mergeable === 'CONFLICTING';
    }
  );

  // label PRs with conflicts
  if (pullrequestsWithConflicts.length > 0) {
    pullrequestsWithConflicts.forEach(async (pullrequest: IGithubPRNode) => {
      const isAlreadyLabeled = pullrequest.node.labels.edges.find(
        (label: IGithubLabelNode) => {
          return label.node.id === conflictLabel.node.id;
        }
      );

      if (isAlreadyLabeled) {
        core.debug(
          `PR #${pullrequest.node.number} skipping, it has conflicts but is already labeled`
        );
      } else {
        core.debug(`PR #${pullrequest.node.number} labeling...`);
        try {
          await addLabelsToLabelable(octokit, {
            labelIds: conflictLabel.node.id,
            labelableId: pullrequest.node.id
          });
          core.debug(`PR #${pullrequest.node.number} labeled`);
        } catch (error) {
          core.setFailed('addLabelsToLabelable request failed: ' + error);
        }
      }
    });
  } else {
    // nothing to do
    core.debug('No PR has conflicts, congrats!');
  }

  let pullrequestsWithConflictResolution: IGithubPRNode[];
  pullrequestsWithConflictResolution = pullRequests.filter(
    (pullrequest: IGithubPRNode) => {
      return pullrequest.node.mergeable === 'MERGEABLE';
    }
  );

  // unlabel PRs without conflicts
  if (pullrequestsWithConflictResolution.length > 0) {
    pullrequestsWithConflictResolution.forEach(
      async (pullrequest: IGithubPRNode) => {
        const isAlreadyLabeled = pullrequest.node.labels.edges.find(
          (label: IGithubLabelNode) => {
            return label.node.id === conflictLabel.node.id;
          }
        );

        if (!isAlreadyLabeled) {
          core.debug(
            `PR #${pullrequest.node.number} skipping unlabel, it has no conflicts and is not labeled`
          );
        } else {
          core.debug(`PR #${pullrequest.node.number} unlabeling...`);
          try {
            await removeLabelsFromLabelable(octokit, {
              labelIds: conflictLabel.node.id,
              labelableId: pullrequest.node.id
            });
            core.debug(`PR #${pullrequest.node.number} unlabeled`);
          } catch (error) {
            core.setFailed('removeLabelsToLabelable request failed: ' + error);
          }
        }
      }
    );
  } else {
    // nothing to do
    core.debug('No PR has resolved conflicts!');
  }
}
