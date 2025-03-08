import express from "express";
import bodyParser from "body-parser";
import multer from "multer";
import pg from "pg";
import bcrypt from "bcrypt";
import session from "express-session";
import passport from "passport";
import { Strategy } from "passport-local";
import flash from "connect-flash";
import env from "dotenv";

const app = express();
const port = 3000;
const saltRounds = 10;
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
env.config();

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 /*session timeout*/,
    },
  })
);

app.use(flash());

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/post", express.static("public"));
app.use("/comment", express.static("public"));
app.use("/reply", express.static("public"));
app.use("/bookmarks", express.static("public"));
app.use("/user-profile/:id", express.static("public"));
app.use("/search-user", express.static("public"));

app.use(passport.initialize());
app.use(passport.session());

const db = new pg.Client({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});

db.connect();

app.use((req, res, next) => {
  res.locals.errorMessage = req.flash("error");
  next();
});

async function getAllPosts(user) {
  const userId = user.id;

  try {
    const response = await db.query(
      `
WITH RECURSIVE reply_hierarchy AS (
    -- Base case: Top-level replies (direct replies to comments)
    SELECT 
        r.id AS reply_id,
        r.comment_id,
        r.reply_id AS parent_reply_id
    FROM replies r
    WHERE r.reply_id IS NULL
    UNION ALL
    -- Recursive case: Child replies (replies to replies)
    SELECT 
        r.id AS reply_id,
        r.comment_id,
        r.reply_id AS parent_reply_id
    FROM replies r
    INNER JOIN reply_hierarchy rh ON r.reply_id = rh.reply_id
),
comment_counts AS (
    -- Count comments for each post
    SELECT 
        c.post_id,
        COUNT(c.id) AS comment_count
    FROM comments c
    GROUP BY c.post_id
),
reply_counts AS (
    -- Count all replies (including child replies) for each post via comment_id
    SELECT 
        c.post_id,
        COUNT(DISTINCT rh.reply_id) AS reply_count
    FROM reply_hierarchy rh
    INNER JOIN comments c ON c.id = rh.comment_id
    GROUP BY c.post_id
)
SELECT 
    p.id AS post_id,
    p.activity,
    p.created_at,
    p.is_active,
    p.user_id AS post_owner_id,
    ur.user_id AS user_id,
    ur.related_user_id,
    ur.relationship_type,
    u.display_name,
    u.profile_picture,
    u.avatar,
    a.image_path,
    COALESCE(cc.comment_count, 0) + COALESCE(rc.reply_count, 0) AS total_comments_and_replies
FROM posts p
LEFT JOIN user_relationships ur ON p.user_id = ur.related_user_id AND ur.user_id = $1
JOIN users u ON u.id = p.user_id
LEFT JOIN avatars a ON u.avatar = a.avatar_name
LEFT JOIN comment_counts cc ON cc.post_id = p.id
LEFT JOIN reply_counts rc ON rc.post_id = p.id
WHERE p.user_id = $1 OR ur.user_id = $1
GROUP BY 
    p.id, p.activity, p.created_at, p.is_active, p.user_id, 
    ur.user_id, ur.related_user_id, ur.relationship_type, 
    u.display_name, u.profile_picture, u.avatar, a.image_path, 
    cc.comment_count, rc.reply_count

    ORDER BY created_at DESC;

      `,
      [userId]
    );
    const result = response.rows;

    const bookmarkResponse = await db.query(
      `
      SELECT post_id
      FROM bookmarks
      WHERE user_id = $1
      `,
      [userId]
    );
    const checkBookmarks = bookmarkResponse.rows;

    // console.log(result);
    if (result.length > 0) {
      if (checkBookmarks.length > 0) {
        const posts = result;
        const checkBookmarkid = [];

        checkBookmarks.forEach((bookmark) => {
          checkBookmarkid.push(bookmark.post_id);
        });

        posts.forEach((post) => {
          if (checkBookmarkid.includes(post.post_id)) {
            post.bookmark = true;
          }
        });

        // console.log(posts);
        return posts;
      } else {
        const posts = result;
        return posts;
      }
    } else {
      console.log("No posts found");
    }
  } catch (err) {
    console.error("Error accessing database on getting posts:", err);
  }
}

async function getUserImage(user) {
  const response = await db.query(
    "SELECT image_path FROM avatars WHERE avatar_name = $1",
    [user.avatar]
  );
  if (response.rows.length > 0) {
    const avatar = response.rows[0]["image_path"];
    return avatar;
  } else {
    console.log("No avatar found");
  }
}

app.get("/", async (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const ongoingPosts = [];
    const completedPosts = [];
    const posts = await getAllPosts(user);
    const userAvatar = await getUserImage(user);

    // console.log(user);
    if (posts) {
      posts.forEach((post) => {
        if (post.is_active == true) {
          ongoingPosts.push(post);
        } else {
          completedPosts.push(post);
        }
      });
    }

    // console.log(ongoingPosts);

    res.render("home.ejs", {
      userAvatar: userAvatar,
      ongoingPosts: ongoingPosts,
      completedPosts: completedPosts,
      userId: user.id,
      user: user,
    });
  } else {
    res.redirect("/login");
  }
});

app.get("/login", (req, res) => {
  res.render("login.ejs");
});

app.get("/register", (req, res) => {
  res.render("register.ejs");
});

app.get("/finish-auth", (req, res) => {
  // console.log("Req.user", req.user);

  if (req.isAuthenticated()) {
    res.render("finish-auth.ejs");
  } else {
    res.redirect("/login");
  }
});

app.get("/create-post", (req, res) => {
  if (req.isAuthenticated()) {
    res.send("Create Post Page");
  } else {
    res.redirect("/login");
  }
});

app.get("/create-comment", (req, res) => {
  const post = req.body["id"];
  res.send("Create Comment Modal");
}); /*authenticate*/

app.get("/post/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const userId = req.user["id"];
    const postId = req.params["id"];
    let arrayOfReplies = [];

    try {
      const postResponse = await db.query(
        `SELECT posts.id AS post_id, posts.activity, 
        posts.created_at, posts.is_active, posts.user_id AS post_owner_id, 
        users.display_name, users.profile_picture, 
        users.avatar, avatars.image_path 
        FROM posts 
        JOIN users 
        ON users.id = posts.user_id 
        LEFT JOIN avatars ON users.avatar = avatars.avatar_name 
        WHERE posts.id = $1`,
        [postId]
      );

      const postResult = postResponse.rows[0];

      const bookmarkResponse = await db.query(
        `
        SELECT post_id 
        FROM bookmarks
        WHERE post_id = $1 And user_id = $2
        `,
        [postId, userId]
      );

      const commentResponse = await db.query(
        `
     WITH RECURSIVE reply_hierarchy AS (
    -- Base case: Top-level replies (direct replies to the comment)
    SELECT 
        r.id AS reply_id,
        r.comment_id,
        r.reply_id AS parent_reply_id
    FROM replies r
    WHERE r.comment_id IS NOT NULL
    UNION ALL
    -- Recursive case: Child replies
    SELECT 
        r.id AS reply_id,
        rh.comment_id,
        r.reply_id AS parent_reply_id
    FROM replies r
    INNER JOIN reply_hierarchy rh ON r.reply_id = rh.reply_id
)
SELECT 
    c.id AS comment_id,
    c.post_id,
    c.message AS comment,
    c.user_id AS commenter_id,
    u.profile_picture,
    u.display_name,
    u.avatar,
    a.avatar_name,
    a.image_path,
    ur.relationship_type,
    c.created_at,
    COUNT(DISTINCT rh.reply_id) AS replies_and_child_replies_count
FROM comments c
JOIN users u ON c.user_id = u.id
LEFT JOIN avatars a ON a.avatar_name = u.avatar
LEFT JOIN user_relationships ur 
    ON ur.user_id = $1 AND c.user_id = ur.related_user_id
LEFT JOIN reply_hierarchy rh ON rh.comment_id = c.id
WHERE c.post_id = $2
GROUP BY 
    c.id, c.post_id, c.message, c.user_id, 
    u.profile_picture, u.display_name, u.avatar, 
    a.avatar_name, a.image_path, ur.relationship_type, c.created_at;

        `,
        [userId, postId]
      );

      if (postResponse.rows.length > 0) {
        if (bookmarkResponse.rows.length == 1) {
          const userAvatar = await getUserImage(user);
          const post = { ...postResult, bookmark: true };
          console.log(post);

          commentResponse.rows.forEach((item) => {
            arrayOfReplies.push(parseInt(item.replies_and_child_replies_count));
          });
          const sumOfReplies = arrayOfReplies.reduce(
            add,
            (commentResponse.rows.length = 0 ? 0 : commentResponse.rows.length)
          );
          function add(accumulator, a) {
            return accumulator + a;
          }
          // console.log(commentResponse.rows);
          // console.log(postResult);
          res.render("post-page.ejs", {
            post: post,
            comments: commentResponse.rows,
            PostRepliesSum: sumOfReplies,
            userAvatar: userAvatar,
            userId: userId,
            user: req.user,
          });
        } else {
          const userAvatar = await getUserImage(user);

          commentResponse.rows.forEach((item) => {
            arrayOfReplies.push(parseInt(item.replies_and_child_replies_count));
          });
          const sumOfReplies = arrayOfReplies.reduce(
            add,
            (commentResponse.rows.length = 0 ? 0 : commentResponse.rows.length)
          );
          function add(accumulator, a) {
            return accumulator + a;
          }
          // console.log(commentResponse.rows);
          // console.log(postResult);
          res.render("post-page.ejs", {
            post: postResult,
            comments: commentResponse.rows,
            PostRepliesSum: sumOfReplies,
            userAvatar: userAvatar,
            userId: userId,
            user: req.user,
          });
        }
      } else {
        console.log("Post does not exist");
      }
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  } else {
    res.redirect("/login");
  }
}); /*authenticate*/

app.get("/comment/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const userId = req.user["id"];
    const commentId = req.params["id"];
    let arrayOfReplies = [];
    try {
      const commentResponse = await db.query(
        `
      SELECT comments.id AS comment_id, comments.message, 
      comments.created_at, comments.user_id AS comment_owner_id, 
      users.display_name, users.profile_picture, 
      users.avatar, avatars.image_path 
      FROM comments 
      JOIN users 
      ON users.id = comments.user_id 
      LEFT JOIN avatars 
      ON users.avatar = avatars.avatar_name 
      WHERE comments.id = $1
      `,
        [commentId]
      );
      const commentResult = commentResponse.rows[0];

      const replyResponse = await db.query(
        `
WITH RECURSIVE reply_hierarchy AS (
    -- Base case: Top-level replies directly associated with the comment
    SELECT 
        r.id AS reply_id,
        r.comment_id,
        r.message,
        r.user_id AS replier_id,
        r.reply_id AS parent_reply_id,
        r.created_at,
        r.id AS top_level_reply_id, -- Track top-level parent
        1 AS depth
    FROM 
        replies r
    WHERE 
        r.comment_id = $1 -- For the specific comment
        AND r.reply_id IS NULL -- Top-level replies (no parent)

    UNION ALL

    -- Recursive case: Include all nested replies
    SELECT 
        r.id AS reply_id,
        rh.comment_id,
        r.message,
        r.user_id AS replier_id,
        r.reply_id AS parent_reply_id,
        r.created_at,
        rh.top_level_reply_id, -- Propagate the top-level parent
        rh.depth + 1 AS depth
    FROM 
        replies r
    INNER JOIN 
        reply_hierarchy rh ON r.reply_id = rh.reply_id -- Link nested replies to their parents
)
SELECT 
    top_replies.reply_id,
    top_replies.comment_id,
    top_replies.message,
    top_replies.replier_id,
    top_replies.depth,
    u.profile_picture,
    u.display_name,
    u.avatar,
    a.avatar_name,
    a.image_path,
    ur.relationship_type,
    top_replies.created_at,
    COALESCE(nested_reply_count.total_nested_replies, 0) AS total_nested_replies
FROM 
    -- Restrict to top-level replies
    reply_hierarchy top_replies
JOIN 
    users u ON top_replies.replier_id = u.id
LEFT JOIN 
    avatars a ON a.avatar_name = u.avatar
LEFT JOIN 
    user_relationships ur ON ur.user_id = $2 AND ur.related_user_id = top_replies.replier_id
LEFT JOIN (
    -- Count all unique descendants for each top-level reply
    SELECT 
        rh.top_level_reply_id,
        COUNT(DISTINCT rh.reply_id) AS total_nested_replies
    FROM 
        reply_hierarchy rh
    WHERE 
        rh.depth > 1 -- Only count nested replies
    GROUP BY 
        rh.top_level_reply_id
) nested_reply_count ON top_replies.reply_id = nested_reply_count.top_level_reply_id
WHERE 
    top_replies.depth = 1 -- Only top-level replies
ORDER BY 
    top_replies.reply_id;


        `,
        [commentId, userId]
      );

      if (commentResponse.rows.length > 0) {
        const userAvatar = await getUserImage(user);
        replyResponse.rows.forEach((item) => {
          arrayOfReplies.push(parseInt(item.total_nested_replies));
        });
        const sumOfReplies = arrayOfReplies.reduce(
          add,
          (replyResponse.rows.length = 0 ? 0 : replyResponse.rows.length)
        );
        function add(accumulator, a) {
          return accumulator + a;
        }
        console.log(replyResponse.rows);
        // console.log("comment", commentResult);

        res.render("comment-page.ejs", {
          comment: commentResult,
          replies: replyResponse.rows,
          sumOfReplies: sumOfReplies,
          userId: userId,
          user: user,
          userAvatar: userAvatar,
        });
      } else {
        console.log("Post does not exist");
      }
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  } else {
    res.redirect("/login");
  }
}); /*authenticate*/

app.get("/reply/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const userId = req.user["id"];
    const replyId = req.params["id"];
    let arrayOfReplies = [];

    try {
      const mainReplyResponse = await db.query(
        `
        SELECT replies.id AS reply_id, replies.message, 
        replies.created_at, replies.user_id AS reply_owner_id, 
        users.display_name, users.profile_picture, 
        users.avatar, avatars.image_path 
        FROM replies 
        JOIN users 
        ON users.id = replies.user_id 
        LEFT JOIN avatars 
        ON users.avatar = avatars.avatar_name 
        WHERE replies.id = $1
        `,
        [replyId]
      );
      const mainReplyResult = mainReplyResponse.rows[0];

      const childReplyResponse = await db.query(
        `
WITH RECURSIVE reply_hierarchy AS (
    -- Base case: Replies where replies.reply_id = $1
    SELECT 
        r.id AS reply_id, 
        r.comment_id, 
        r.message, 
        r.user_id AS replier_id, 
        r.reply_id AS parent_reply_id,
        1 AS depth
    FROM 
        replies r
    WHERE 
        r.reply_id = $1

    UNION ALL

    -- Recursive case: Nested replies
    SELECT 
        r.id AS reply_id, 
        rh.comment_id, 
        r.message, 
        r.user_id AS replier_id, 
        r.reply_id AS parent_reply_id,
        rh.depth + 1 AS depth
    FROM 
        replies r
    INNER JOIN 
        reply_hierarchy rh ON r.reply_id = rh.reply_id
)
SELECT 
    base_replies.reply_id, 
    base_replies.comment_id, 
    base_replies.message, 
    base_replies.replier_id, 
    base_replies.depth, 
    u.profile_picture, 
    u.display_name, 
    u.avatar, 
    a.avatar_name, 
    a.image_path, 
    ur.relationship_type,
    COALESCE(nested_reply_count.total_nested_replies, 0) AS total_nested_replies
FROM 
    -- Restrict to base replies with depth = 1 (i.e., replies.reply_id = $1)
    (SELECT * FROM reply_hierarchy WHERE depth = 1) base_replies
JOIN 
    users u ON base_replies.replier_id = u.id
LEFT JOIN 
    avatars a ON a.avatar_name = u.avatar
LEFT JOIN 
    user_relationships ur ON ur.user_id = $2 AND ur.related_user_id = base_replies.replier_id
LEFT JOIN (
    -- Count all nested replies for each base reply
    SELECT 
        rh_parent.reply_id AS parent_reply_id,
        COUNT(rh_child.reply_id) AS total_nested_replies
    FROM 
        reply_hierarchy rh_parent
    LEFT JOIN 
        reply_hierarchy rh_child ON rh_child.parent_reply_id = rh_parent.reply_id
    GROUP BY 
        rh_parent.reply_id
) nested_reply_count ON base_replies.reply_id = nested_reply_count.parent_reply_id
ORDER BY 
    base_replies.reply_id;


        `,
        [replyId, userId]
      );

      // console.log(childReplyResponse.rows);

      if (mainReplyResponse.rows.length > 0) {
        const userAvatar = await getUserImage(user);
        childReplyResponse.rows.forEach((item) => {
          arrayOfReplies.push(parseInt(item.total_nested_replies));
        });
        const sumOfReplies = arrayOfReplies.reduce(
          add,
          (childReplyResponse.rows.length = 0
            ? 0
            : childReplyResponse.rows.length)
        );
        function add(accumulator, a) {
          return accumulator + a;
        }
        // console.log(childReplyResponse.rows);
        // console.log("comment", mainReplyResult);

        res.render("reply-page.ejs", {
          mainReply: mainReplyResult,
          replies: childReplyResponse.rows,
          sumOfReplies: sumOfReplies,
          userId: userId,
          user: user,
          userAvatar: userAvatar,
        });
      } else {
        console.log("Post does not exist");
      }
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  } else {
    res.redirect("/login");
  }
}); /*authenticate*/

app.get("/bookmarks", async (req, res) => {
  if (req.isAuthenticated()) {
    const userId = req.user["id"];
    try {
      const response = await db.query(
        `
WITH RECURSIVE reply_hierarchy AS (
    -- Base case: Top-level replies (direct replies to comments)
    SELECT 
        r.id AS reply_id,
        r.comment_id,
        r.reply_id AS parent_reply_id
    FROM replies r
    WHERE r.reply_id IS NULL
    UNION ALL
    -- Recursive case: Child replies (replies to replies)
    SELECT 
        r.id AS reply_id,
        r.comment_id,
        r.reply_id AS parent_reply_id
    FROM replies r
    INNER JOIN reply_hierarchy rh ON r.reply_id = rh.reply_id
),
comment_counts AS (
    -- Count comments for each post
    SELECT 
        c.post_id,
        COUNT(c.id) AS comment_count
    FROM comments c
    GROUP BY c.post_id
),
reply_counts AS (
    -- Count all replies (including nested replies) for each post via comment_id
    SELECT 
        c.post_id,
        COUNT(rh.reply_id) AS reply_count
    FROM reply_hierarchy rh
    INNER JOIN comments c ON c.id = rh.comment_id
    GROUP BY c.post_id
)
SELECT 
    p.id AS post_id,
    p.activity,
    p.created_at,
    p.is_active,
    p.user_id AS post_owner_id,
    ur.user_id AS user_id,
    ur.related_user_id,
    ur.relationship_type,
    u.display_name,
    u.profile_picture,
    u.avatar,
    a.image_path,
    b.post_id AS bookmarked_post_id,
    b.id AS bookmark_id,
    COALESCE(cc.comment_count, 0) + COALESCE(rc.reply_count, 0) AS total_comments_and_replies
FROM posts p
JOIN bookmarks b ON b.post_id = p.id AND b.user_id = $1
LEFT JOIN user_relationships ur ON p.user_id = ur.related_user_id AND ur.user_id = $1
JOIN users u ON u.id = p.user_id
LEFT JOIN avatars a ON u.avatar = a.avatar_name
LEFT JOIN comment_counts cc ON cc.post_id = p.id
LEFT JOIN reply_counts rc ON rc.post_id = p.id
WHERE b.user_id = $1
GROUP BY 
    p.id, p.activity, p.created_at, p.is_active, p.user_id, 
    ur.user_id, ur.related_user_id, ur.relationship_type, 
    u.display_name, u.profile_picture, u.avatar, a.image_path, 
    b.post_id, cc.comment_count, b.id, rc.reply_count;

  `,
        [userId]
      );
      const result = response.rows;

      if (result.length > 0) {
        // console.log(result)

        res.render("bookmarks.ejs", { bookmarks: result, userId });
      } else {
        console.log("No bookmars found");
        res.render("bookmarks.ejs", {
          noBookmarks: "No bookmarks found.",
          userId,
        });
      }
    } catch (err) {}
  } else {
    res.redirect("/login");
  }
});

app.get("/user-profile/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const userId = req.user["id"];
    const receivedUserId = req.params["id"];
    const ongoingPosts = [];
    const completedPosts = [];
    const userAvatar = await getUserImage(user);

    const detailResponse = await db.query(
      `
SELECT 
    users.id, 
    users.email, 
    users.display_name, 
    users.description, 
    users.profile_picture, 
    users.avatar, 
    avatars.image_path, 
    u_r.relationship_type
FROM 
    users
LEFT JOIN 
    avatars
ON 
    avatars.avatar_name = users.avatar
LEFT JOIN 
    user_relationships AS u_r
ON 
    u_r.related_user_id = users.id AND u_r.user_id = $1
WHERE 
    users.id = $2
    `,
      [userId, receivedUserId]
    );

    const postResponse = await db.query(
      `
    WITH RECURSIVE reply_hierarchy AS (
  -- Base case: Top-level replies (direct replies to comments)
  SELECT 
      r.id AS reply_id,
      r.comment_id,
      r.reply_id AS parent_reply_id
  FROM replies r
  WHERE r.reply_id IS NULL
  UNION ALL
  -- Recursive case: Child replies (replies to replies)
  SELECT 
      r.id AS reply_id,
      r.comment_id,
      r.reply_id AS parent_reply_id
  FROM replies r
  INNER JOIN reply_hierarchy rh ON r.reply_id = rh.reply_id
),
comment_counts AS (
  -- Count comments for each post
  SELECT 
      c.post_id,
      COUNT(c.id) AS comment_count
  FROM comments c
  GROUP BY c.post_id
),
reply_counts AS (
  -- Count all replies (including child replies) for each post via comment_id
  SELECT 
      c.post_id,
      COUNT(DISTINCT rh.reply_id) AS reply_count
  FROM reply_hierarchy rh
  INNER JOIN comments c ON c.id = rh.comment_id
  GROUP BY c.post_id
)
SELECT 
  p.id AS post_id,
  p.activity,
  p.created_at,
  p.is_active,
  p.user_id AS post_owner_id,
  u.id AS user_id,
  u.display_name,
  u.profile_picture,
  u.avatar,
u.email,
u.description,
  a.image_path,
  COALESCE(cc.comment_count, 0) + COALESCE(rc.reply_count, 0) AS total_comments_and_replies
FROM posts p
JOIN users u ON u.id = p.user_id
LEFT JOIN avatars a ON u.avatar = a.avatar_name
LEFT JOIN comment_counts cc ON cc.post_id = p.id
LEFT JOIN reply_counts rc ON rc.post_id = p.id
WHERE u.id = $1 -- Filter for the specific user with user.id = $1
GROUP BY 
  p.id, p.activity, p.created_at, p.is_active, p.user_id, 
  u.id, u.display_name, u.profile_picture, u.avatar, u.email, u.description, a.image_path, 
  cc.comment_count, rc.reply_count
  ORDER BY created_at DESC;

    `,
      [receivedUserId]
    );
    const posts = postResponse.rows;

    const followerResponse = await db.query(
      `
      SELECT COUNT(*) AS follower_count
      FROM user_relationships
      WHERE related_user_id = $1;
      `,
      [receivedUserId]
    );

    // const followersCount = followerResponse.rows[0];

    const followingResponse = await db.query(
      `
      SELECT COUNT(*) AS following_count
      FROM user_relationships
      WHERE user_id = $1;
      `,
      [receivedUserId]
    );

    console.log("this", followingResponse.rows[0]);

    const relationshipDetails = {
      followersCount: followerResponse.rows[0].follower_count,
      followingCount: followingResponse.rows[0].following_count,
    };

    const bookmarkResponse = await db.query(
      `
      SELECT post_id
      FROM bookmarks
      WHERE user_id = $1 
      `,
      [userId]
    );

    if (posts.length > 0) {
      if (bookmarkResponse.rows.length > 0) {
        const checkBookmarkid = [];
        const newPost = postResponse.rows;

        bookmarkResponse.rows.forEach((post) => {
          checkBookmarkid.push(post.post_id);
        });

        newPost.forEach((post) => {
          if (checkBookmarkid.includes(post.post_id)) {
            post.bookmark = true;
          }
        });

        console.log(newPost);

        newPost.forEach((post) => {
          if (post.is_active == true) {
            ongoingPosts.push(post);
          } else {
            completedPosts.push(post);
          }
        });

        const details = detailResponse.rows[0];
        // console.log(followersCount);

        res.render("profile.ejs", {
          userAvatar: userAvatar,
          details: details,
          ongoingPosts: ongoingPosts,
          completedPosts: completedPosts,
          relationshipDetails: relationshipDetails,
          userId: userId,
          user: user,
        });
      } else {
        if (posts) {
          posts.forEach((post) => {
            if (post.is_active == true) {
              ongoingPosts.push(post);
            } else {
              completedPosts.push(post);
            }
          });
        }

        const details = detailResponse.rows[0];
        // console.log(details);
        res.render("profile.ejs", {
          userAvatar: userAvatar,
          details: details,
          ongoingPosts: ongoingPosts,
          completedPosts: completedPosts,
          relationshipDetails: relationshipDetails,
          userId: userId,
          user: user,
        });
      }
    } else {
      const details = detailResponse.rows[0];
      // console.log(details);
      res.render("profile.ejs", {
        userAvatar: userAvatar,
        details: details,
        ongoingPosts: ongoingPosts,
        completedPosts: completedPosts,
        userId: userId,
        user: user,
      });
    }
  } else {
    res.redirect("/login");
  }
});

app.get("/explore", async (req, res) => {
  if (req.isAuthenticated()) {
    const userId = req.user["id"];
    const user = req.user;
    const ongoingPosts = [];
    const completedPosts = [];
    const userAvatar = await getUserImage(user);
    try {
      const response = await db.query(
        `
        WITH RECURSIVE reply_hierarchy AS (
      -- Base case: Top-level replies (direct replies to comments)
      SELECT 
          r.id AS reply_id,
          r.comment_id,
          r.reply_id AS parent_reply_id
      FROM replies r
      WHERE r.reply_id IS NULL
      UNION ALL
      -- Recursive case: Child replies (replies to replies)
      SELECT 
          r.id AS reply_id,
          r.comment_id,
          r.reply_id AS parent_reply_id
      FROM replies r
      INNER JOIN reply_hierarchy rh ON r.reply_id = rh.reply_id
  ),
  comment_counts AS (
      -- Count comments for each post
      SELECT 
          c.post_id,
          COUNT(c.id) AS comment_count
      FROM comments c
      GROUP BY c.post_id
  ),
  reply_counts AS (
      -- Count all replies (including child replies) for each post via comment_id
      SELECT 
          c.post_id,
          COUNT(DISTINCT rh.reply_id) AS reply_count
      FROM reply_hierarchy rh
      INNER JOIN comments c ON c.id = rh.comment_id
      GROUP BY c.post_id
  )
  SELECT 
      p.id AS post_id,
      p.activity,
      p.created_at,
      p.is_active,
      p.user_id AS post_owner_id,
      ur.user_id AS user_id,
      ur.related_user_id,
      ur.relationship_type,
      u.display_name,
      u.profile_picture,
      u.avatar,
      a.image_path,
      COALESCE(cc.comment_count, 0) + COALESCE(rc.reply_count, 0) AS total_comments_and_replies
  FROM posts p
  LEFT JOIN user_relationships ur ON p.user_id = ur.related_user_id AND ur.user_id = $1
  JOIN users u ON u.id = p.user_id
  LEFT JOIN avatars a ON u.avatar = a.avatar_name
  LEFT JOIN comment_counts cc ON cc.post_id = p.id
  LEFT JOIN reply_counts rc ON rc.post_id = p.id
  GROUP BY 
      p.id, p.activity, p.created_at, p.is_active, p.user_id, 
      ur.user_id, ur.related_user_id, ur.relationship_type, 
      u.display_name, u.profile_picture, u.avatar, a.image_path, 
      cc.comment_count, rc.reply_count;
  
        `,
        [userId]
      );
      const posts = response.rows;

      const bookmarkResponse = await db.query(
        `
        SELECT post_id
        FROM bookmarks
        WHERE user_id = $1
        `,
        [userId]
      );

      const checkBookmarks = bookmarkResponse.rows;

      if (posts.length > 0) {
        if (checkBookmarks.length > 0) {
          const checkBookmarkid = [];

          checkBookmarks.forEach((bookmark) => {
            checkBookmarkid.push(bookmark.post_id);
          });

          posts.forEach((post) => {
            if (post.is_active == true) {
              ongoingPosts.push(post);
            } else {
              completedPosts.push(post);
            }
          });

          ongoingPosts.forEach((post) => {
            if (checkBookmarkid.includes(post.post_id)) {
              post.bookmark = true;
            }
          });

          res.render("home.ejs", {
            userAvatar: userAvatar,
            ongoingPosts: ongoingPosts,
            completedPosts: completedPosts,
            userId: userId,
            user: user,
            pageLabel: "Explore",
          });
        } else {
          posts.forEach((post) => {
            if (post.is_active == true) {
              ongoingPosts.push(post);
            } else {
              completedPosts.push(post);
            }
          });

          res.render("home.ejs", {
            userAvatar: userAvatar,
            ongoingPosts: ongoingPosts,
            completedPosts: completedPosts,
            userId: userId,
            user: user,
            pageLabel: "Explore",
          });
        }
      } else {
        console.log("No posts to Explore");
        res.render("home.ejs", {
          userAvatar: userAvatar,
          ongoingPosts: ongoingPosts,
          completedPosts: completedPosts,
          userId: userId,
          user: user,
          pageLabel: "Explore",
        });
      }
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  } else {
    res.redirect("/login");
  }
});

app.get("/search-user", async (req, res) => {
  try {
    const userId = req.user["id"];
    const pageLabel = "Search";

    const response = await db.query(
      `
      SELECT users.id AS user_id, users.display_name, users.email, users.description, users.profile_picture, users.avatar, 
	    avatars.image_path, ur.relationship_type
      FROM users
      LEFT JOIN avatars 
      ON users.avatar = avatars.avatar_name
      LEFT JOIN user_relationships AS ur
      ON ur.user_id = $1 AND ur.related_user_id = users.id

      `,
      [userId]
    );
    const allUsers = response.rows;
    console.log(allUsers);

    res.render("search.ejs", {
      allUsers: allUsers,
      userId,
      pageLabel: pageLabel,
    });
  } catch (err) {
    console.error("Error accessing databas:", err);
  }
});

app.get("/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      console.log(err);
    } else {
      res.redirect("/login");
    }
  });
});

app.post(
  "/login",
  passport.authenticate("local", {
    successRedirect: "/",
    failureRedirect: "/login",
    failureFlash: true,
  })
);

app.post("/register", async (req, res) => {
  const username = req.body["username"];
  const password = req.body["password"];

  try {
    const checkUser = await db.query("SELECT * FROM users WHERE email = $1", [
      username,
    ]);

    if (checkUser.rows.length > 0) {
      console.log("User already exist. Try login.");
      req.flash("error", "You already have an account. Please Sign In.");
      // res.redirect("/login");
      res.redirect(req.get("referer"));
    } else {
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          console.error("Error hashing password", err);
        } else {
          const user = {
            username: username,
            password: hash,
          };
          // console.log(user);

          req.login(user, (err) => {
            res.redirect("/finish-auth");
          });
        }
      });
    }
  } catch (err) {
    console.error("Error accessing database", err);
  }
});

app.post("/finish-auth", upload.single("profile-picture"), async (req, res) => {
  const username = req.user["username"];
  const password = req.user["password"];
  const image = req.file;
  const avatarName = req.body["avatar"];
  const displayName = req.body["displayname"];

  // console.log("avatar", avatarPath);
  // console.log("profile", image);

  try {
    const response = await db.query(
      "INSERT INTO users (email, password, display_name, profile_picture, avatar) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [
        username,
        password,
        displayName,
        req.file ? image.buffer : null,
        avatarName ? avatarName : null,
      ]
    );
    const user = response.rows[0];
    req.login(user, (err) => {
      console.log("success", user.profile_picture, user.email);
      res.redirect("/");
    });
  } catch (err) {
    console.error("Error acessing database", err);
  }
});

app.post("/submit-post", async (req, res) => {
  const userId = req.user["id"];
  const activity = req.body["activity"];
  try {
    await db.query("INSERT INTO posts ( activity, user_id) VALUES ($1, $2)", [
      activity,
      userId,
    ]);
    res.redirect(req.get("referer"));
  } catch (err) {
    console.error("Error accessing database:", err);
  }
});

app.post("/submit-reply", async (req, res) => {
  const userId = req.user["id"];
  const postId = req.body["post-id"];

  if (req.body["comment"]) {
    const comment = req.body["comment"];

    try {
      const response = await db.query(`SELECT * FROM posts WHERE id = $1`, [
        postId,
      ]);
      const result = response.rows;

      if (result.length > 0) {
        await db.query(
          "INSERT INTO comments (message, post_id, user_id) VALUES ($1, $2, $3)",
          [comment, postId, userId]
        );
        res.redirect(req.get("referer"));
      } else {
        console.log("Post does not exist");
      }
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  } else if (req.body["reply-to-comment"]) {
    const reply = req.body["reply-to-comment"];
    try {
      const response = await db.query(`SELECT * FROM comments WHERE id = $1`, [
        postId,
      ]);
      const result = response.rows;

      if (result.length > 0) {
        await db.query(
          "INSERT INTO replies (message, comment_id, user_id) VALUES ($1, $2, $3)",
          [reply, postId, userId]
        );
        res.redirect(req.get("referer"));
      } else {
        console.log("Comment does not exist");
      }
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  } else if (req.body["child-reply"]) {
    const reply = req.body["child-reply"];
    try {
      const response = await db.query(`SELECT * FROM replies WHERE id = $1`, [
        postId,
      ]);
      const result = response.rows;
      console.log("see", result);
      const parentComment = result[0].comment_id;

      if (result.length > 0) {
        await db.query(
          "INSERT INTO replies (message, comment_id, user_id, reply_id) VALUES ($1, $2, $3, $4)",
          [reply, parentComment, userId, postId]
        );
        res.redirect(req.get("referer"));
      } else {
        console.log("Comment does not exist");
      }
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  }
});

app.post("/follow", async (req, res) => {
  const userId = req.user["id"];
  const relatedUserId = req.body["postOwnerId"];
  const relationshipType = "following";

  console.log(relatedUserId);

  try {
    const response = await db.query(
      "SELECT * FROM user_relationships WHERE user_id = $1 AND related_user_id = $2 AND relationship_type = $3",
      [userId, relatedUserId, relationshipType]
    );

    if (response.rows.length > 0) {
      console.log("You are already following this user");
    } else {
      await db.query(
        "INSERT INTO user_relationships (user_id, related_user_id, relationship_type) VALUES ($1, $2, $3)",
        [userId, relatedUserId, relationshipType]
      );

      res.redirect(req.get("referer"));
    }
  } catch (err) {
    console.log("Error accessing database:", err);
  }
});

app.post("/unfollow", async (req, res) => {
  const userId = req.user["id"];
  const relatedUserId = req.body["postOwnerId"];

  console.log(req.body.postOwnerId);

  try {
    const response = await db.query(
      "SELECT * FROM user_relationships WHERE user_id = $1 AND related_user_id = $2",
      [userId, relatedUserId]
    );

    if (response.rows.length > 0) {
      const followId = response.rows[0]["id"];
      await db.query("DELETE FROM user_relationships WHERE id = ($1)", [
        followId,
      ]);

      res.redirect(req.get("referer"));
    } else {
      console.log("You are not following this user");
    }
  } catch (err) {
    console.log("Error accessing database:", err);
  }
});

app.post("/add-bookmark", async (req, res) => {
  const userId = req.user["id"];
  const postId = req.body["post-id"];

  try {
    const response = await db.query(
      `SELECT * FROM bookmarks WHERE post_id = $1 AND user_id = $2`,
      [postId, userId]
    );
    if (response.rows.length > 0) {
      console.log("You already bookmarked this post");
    } else {
      await db.query(
        `INSERT INTO bookmarks (user_id, post_id) VALUES ($1, $2)`,
        [userId, postId]
      );

      res.redirect(req.get("referer"));
    }
  } catch (err) {
    console.error("Error accessing database:", err);
  }
});

app.post("/remove-bookmark", async (req, res) => {
  const userId = req.user["id"];

  if (req.body["bookmark-id"]) {
    const bookmarkId = req.body["bookmark-id"];

    try {
      const response = await db.query(
        `SELECT * FROM bookmarks WHERE id = $1 AND user_id = $2`,
        [bookmarkId, userId]
      );

      if (response.rows.length > 0) {
        await db.query(`DELETE FROM bookmarks WHERE id = $1 AND user_id = $2`, [
          bookmarkId,
          userId,
        ]);
        res.redirect(req.get("referer"));
      } else {
        console.log("Bookmark does not exist");
      }
    } catch (err) {
      console.log("Error accessing database", err);
    }
  } else if (req.body["post-id"]) {
    // console.log(req.body["post-id"]);

    const postId = req.body["post-id"];

    try {
      const response = await db.query(
        `SELECT * FROM bookmarks WHERE post_id = $1 AND user_id = $2`,
        [postId, userId]
      );

      if (response.rows.length > 0) {
        await db.query(
          `DELETE FROM bookmarks WHERE post_id = $1 AND user_id = $2`,
          [postId, userId]
        );
        res.redirect(req.get("referer"));
      } else {
        console.log("Bookmark does not exist");
      }
    } catch (err) {
      console.log("Error accessing database", err);
    }
  }
});

app.post("/complete-activity", async (req, res) => {
  const userId = req.user["id"];
  const postId = req.body["post-id"];
  console.log(postId);

  try {
    const response = await db.query(
      `SELECT * FROM posts WHERE id = $1 AND user_id = $2`,
      [postId, userId]
    );
    if (response.rows.length > 0) {
      await db.query(
        `
      UPDATE posts
      SET is_active = false
      WHERE id = $1
      `,
        [postId]
      );

      res.redirect(req.get("referer"));
    } else {
      console.log("Post does not exist");
    }
  } catch (err) {
    console.log("Error accessing database", err);
  }
});

app.post(
  "/save-profile",
  upload.single("profile-picture"),
  async (req, res) => {
    const userid = req.user["id"];
    const avatar = req.body["avatar"];
    const displayName = req.body["display-name"];
    const description = req.body["description"];

    req.user.avatar = avatar;
    req.user.displayName = displayName;
    req.user.description = description;
    try {
      await db.query(
        `
      UPDATE users
       SET display_name = $1, 
       description = $2,
       avatar = $3 
       WHERE id = $4
      `,
        [displayName, description, avatar, userid]
      );
      console.log(description);

      res.redirect(req.get("referer"));
    } catch (err) {
      console.error("Error accessing database:", err);
    }
  }
);

passport.use(
  "local",
  new Strategy(async function verify(username, password, cb) {
    try {
      const checkUser = await db.query("SELECT * FROM users WHERE email = $1", [
        username,
      ]);

      if (checkUser.rows.length > 0) {
        const user = checkUser.rows[0];
        const storedHash = user["password"];
        // console.log(user);

        bcrypt.compare(password, storedHash, (err, valid) => {
          if (err) {
            console.error("Error comparing passwords:", err);
            return cb(err);
          } else {
            if (valid) {
              return cb(null, user);
            } else {
              console.log("Wrong password, try again.");
              // req.flash("wrong", "wrong password. Try again.");

              return cb(null, false, { message: "Wrong password. Try again." });
            }
          }
        });
      } else {
        console.log("You don't have an account. Try Registering.");
        return cb(null, false, {
          message: "You don't have an account. Please Sign up.",
        });
      }
    } catch (err) {
      console.error("Error Checking Database", err);
    }
  })
);

passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
