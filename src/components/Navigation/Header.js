// © 2021 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
// This AWS Content is provided subject to the terms of the AWS Customer Agreement available at
// http://aws.amazon.com/agreement or other written agreement between Customer and either
// Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
/* eslint-disable jsx-a11y/anchor-is-valid */
import React, { useState, useEffect } from "react";
import Alert from "@cloudscape-design/components/alert";
import "../../index.css";
import params from "../../parameters.json";
import { signOut } from "aws-amplify/auth";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import { useHistory } from "react-router-dom";
import teamLogo from "../../media/vertice-team-logo.png";

function Header(props) {
  const history = useHistory();
  const [visible, setVisible] = useState(false);
  const notificationId = params.NotificationId;
  const [hasUnread, setHasUnread] = useState(
    () => localStorage.getItem("lastReadNotification") !== notificationId
  );

  useEffect(() => {
    if (!hasUnread) {
      localStorage.setItem("lastReadNotification", notificationId);
    }
  }, [hasUnread, notificationId]);

  async function handleSignOut() {
    try {
      await signOut();
    } catch (error) {
      console.log("error signing out");
    }
  }

  function Notification() {
    return (
      <Alert
        dismissible
        statusIconAriaLabel="Info"
        header={params.NotificationTitle}
        visible={visible}
        onDismiss={() => setVisible(false)}
      >
        🚀 {params.NotificationMessage}
      </Alert>
    );
  }

  return (
    <div>
      <TopNavigation
        identity={{
          href: "/",
          logo: {
            src: teamLogo,
            alt: "VxTEAM",
          },
        }}
        utilities={[
          {
            type: "button",
            text: "IAM Identity Center",
            href: `${params.Login}`,
            external: true,
            externalIconAriaLabel: " (opens in a new tab)",
          },
          {
            type: "button",
            iconName: "notification",
            title: "Notifications",
            ariaLabel: hasUnread ? "Notifications (unread)" : "Notifications",
            badge: hasUnread,
            disableUtilityCollapse: false,
            onClick: () => {
              setVisible(!visible);
              setHasUnread(false);
            },
          },
          {
            type: "button",
            text: params.Version,
            href: params.ReleasesUrl,
            external: true,
            externalIconAriaLabel: " (opens in a new tab)",
          },
          {
            type: "menu-dropdown",
            text: `${props.user}`,
            description: `${props.user}`,
            iconName: "user-profile",
            onItemClick: ({ detail }) => {
              if (detail.id === "signout") {
                handleSignOut().then(() => history.push("/"));
              }
            },
            items: [
              { id: "signout", text: "Sign out" },
              {
                id: "support-group",
                text: "Support",
                items: [
                  {
                    id: "documentation",
                    text: "Documentation",
                    href: params.DocumentationUrl,
                    external: true,
                    externalIconAriaLabel: " (opens in new tab)",
                  },
                  { id: "support", text: "Support" },
                  {
                    id: "feedback",
                    text: "Feedback",
                    href: params.FeedbackUrl,
                    external: true,
                    externalIconAriaLabel: " (opens in new tab)",
                  },
                  {
                    id: "bug",
                    text: "Report Bug",
                    href: params.IssuesUrl,
                    external: true,
                    externalIconAriaLabel: " (opens in new tab)",
                  },
                ],
              },
            ],
          },
        ]}
        onFollow={() => {
          history.push("/");
          props.setActiveHref("/");
          props.addNotification([]);
        }}
      />
      <Notification />
    </div>
  );
}

export default Header;
