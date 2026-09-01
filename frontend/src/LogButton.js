import ArticleIcon from "@mui/icons-material/Article";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";


const LogButton = ({ onClick, disabled }) => {
    return (
        <FormControlLabel disabled={disabled}
            control={
                <IconButton onClick={onClick}>
                    <ArticleIcon />
                </IconButton>
            }
        />
    );
};


export default LogButton;
